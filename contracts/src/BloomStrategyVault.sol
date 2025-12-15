// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IStrategy.sol";

/**
 * @title BloomStrategyVault
 * @notice ERC4626 vault with two-step withdrawal for async strategy fulfillment
 * 
 * Deposit Flow:
 *   User deposits → Vault mints shares → Strategy receives funds
 * 
 * Withdrawal Flow (Two-Step):
 *   1. User calls requestWithdrawal(shares) → shares burned, request queued
 *   2. Keeper fulfills via strategy → USDC sent back to vault
 *   3. User calls claimWithdrawal(requestId) → receives USDC
 */
contract BloomStrategyVault is ERC4626, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════════

    struct WithdrawalRequest {
        uint256 id;
        address user;
        uint256 assets;      // Amount of underlying asset owed
        uint256 shares;      // Shares that were burned
        uint256 requestedAt;
        bool fulfilled;      // True when USDC is available in vault
        bool claimed;        // True when user has claimed
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════

    // Strategy Management
    address[] public strategies;
    mapping(address => bool) public isStrategy;
    
    // User deposit tracking
    mapping(address => mapping(address => uint256)) public usersDeposits;
    mapping(address => mapping(address => uint256)) public allocations;
    
    // Withdrawal request tracking
    mapping(uint256 => WithdrawalRequest) public withdrawalRequests;
    uint256 public nextWithdrawalId;
    uint256 public totalPendingWithdrawals;  // Total assets pending (not yet fulfilled)
    uint256 public totalFulfilledUnclaimed;  // Total fulfilled but not claimed
    
    // Per-user pending tracking
    mapping(address => uint256) public userPendingWithdrawals;
    
    // Dividend Tracking
    uint256 public accRewardPerShare;
    mapping(address => uint256) public rewardDebt;
    
    // Constants
    uint256 public constant BPS_SCALE = 10000;
    uint256 public constant REWARD_PRECISION = 1e12;

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event WithdrawalRequested(
        uint256 indexed requestId,
        address indexed user,
        uint256 assets,
        uint256 shares,
        uint256 timestamp
    );

    event WithdrawalFulfilled(uint256 indexed requestId, uint256 assets);
    
    event WithdrawalClaimed(
        uint256 indexed requestId,
        address indexed user,
        uint256 assets
    );

    event StrategyRegistered(address indexed strategy);

    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error InsufficientShares();
    error InvalidRequest();
    error NotYourRequest();
    error AlreadyClaimed();
    error NotYetFulfilled();
    error ZeroAmount();

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    constructor(
        IERC20 _asset,
        address _initialStrategy
    ) ERC4626(_asset) ERC20("Bloom Strategy Vault", "BSV") Ownable(msg.sender) {
        if (_initialStrategy != address(0)) {
            registerStrategy(_initialStrategy);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ERC4626 OVERRIDES - DEPOSITS
    // ═══════════════════════════════════════════════════════════════════════════

    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal override {
        // Settle pending rewards before share balance changes
        _settleRewards(receiver);
        
        super._deposit(caller, receiver, assets, shares);
        
        // Track user deposit
        usersDeposits[receiver][asset()] += assets;
        
        // Allocate to strategies
        if (strategies.length > 0) {
            uint256 amountPerStrategy = assets / strategies.length;
            for (uint256 i = 0; i < strategies.length; i++) {
                allocations[strategies[i]][receiver] += amountPerStrategy;
                IStrategy(strategies[i]).deposit(amountPerStrategy);
            }
        }
        
        // Update reward debt
        rewardDebt[receiver] = (balanceOf(receiver) * accRewardPerShare) / REWARD_PRECISION;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TWO-STEP WITHDRAWALS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Request a withdrawal - Step 1
     * @param shares Amount of shares to redeem
     * @return requestId The ID of the withdrawal request
     * @dev Burns shares immediately, queues request for fulfillment
     */
    function requestWithdrawal(uint256 shares) external nonReentrant returns (uint256 requestId) {
        if (shares == 0) revert ZeroAmount();
        if (shares > balanceOf(msg.sender)) revert InsufficientShares();
        
        // Settle rewards before burning
        _settleRewards(msg.sender);
        
        // Calculate assets based on current share price
        uint256 assets = previewRedeem(shares);
        
        // Burn shares immediately
        _burn(msg.sender, shares);
        
        // Create withdrawal request
        requestId = nextWithdrawalId++;
        withdrawalRequests[requestId] = WithdrawalRequest({
            id: requestId,
            user: msg.sender,
            assets: assets,
            shares: shares,
            requestedAt: block.timestamp,
            fulfilled: false,
            claimed: false
        });
        
        // Update tracking
        totalPendingWithdrawals += assets;
        userPendingWithdrawals[msg.sender] += assets;
        
        // Update user deposit tracking
        if (usersDeposits[msg.sender][asset()] >= assets) {
            usersDeposits[msg.sender][asset()] -= assets;
        } else {
            usersDeposits[msg.sender][asset()] = 0;
        }
        
        // Request from strategies
        _requestFromStrategies(assets);
        
        // Update reward debt
        rewardDebt[msg.sender] = (balanceOf(msg.sender) * accRewardPerShare) / REWARD_PRECISION;
        
        emit WithdrawalRequested(requestId, msg.sender, assets, shares, block.timestamp);
    }

    /**
     * @notice Claim a fulfilled withdrawal - Step 2
     * @param requestId The ID of the withdrawal request
     * @dev Only callable after keeper has fulfilled the request
     */
    function claimWithdrawal(uint256 requestId) external nonReentrant {
        WithdrawalRequest storage req = withdrawalRequests[requestId];
        
        if (req.user == address(0)) revert InvalidRequest();
        if (req.user != msg.sender) revert NotYourRequest();
        if (req.claimed) revert AlreadyClaimed();
        if (!req.fulfilled) revert NotYetFulfilled();
        
        req.claimed = true;
        
        // Update tracking
        totalFulfilledUnclaimed -= req.assets;
        userPendingWithdrawals[msg.sender] -= req.assets;
        
        // Transfer to user
        IERC20(asset()).safeTransfer(msg.sender, req.assets);
        
        emit WithdrawalClaimed(requestId, msg.sender, req.assets);
    }

    /**
     * @notice Mark a withdrawal as fulfilled (called when funds arrive)
     * @param requestId The request to mark as fulfilled
     * @dev Can be called by owner or strategy
     */
    function markWithdrawalFulfilled(uint256 requestId) external {
        require(msg.sender == owner() || isStrategy[msg.sender], "Unauthorized");
        
        WithdrawalRequest storage req = withdrawalRequests[requestId];
        if (req.user == address(0)) revert InvalidRequest();
        require(!req.fulfilled, "Already fulfilled");
        
        req.fulfilled = true;
        totalPendingWithdrawals -= req.assets;
        totalFulfilledUnclaimed += req.assets;
        
        emit WithdrawalFulfilled(requestId, req.assets);
    }

    /**
     * @notice Batch mark withdrawals as fulfilled
     * @param requestIds Array of request IDs to fulfill
     */
    function markWithdrawalsFulfilledBatch(uint256[] calldata requestIds) external {
        require(msg.sender == owner() || isStrategy[msg.sender], "Unauthorized");
        
        for (uint256 i = 0; i < requestIds.length; i++) {
            WithdrawalRequest storage req = withdrawalRequests[requestIds[i]];
            if (req.user != address(0) && !req.fulfilled) {
                req.fulfilled = true;
                totalPendingWithdrawals -= req.assets;
                totalFulfilledUnclaimed += req.assets;
                emit WithdrawalFulfilled(requestIds[i], req.assets);
            }
        }
    }

    /**
     * @notice Request withdrawal from strategies
     * @param amount Total amount to request
     */
    function _requestFromStrategies(uint256 amount) internal {
        if (strategies.length == 0) return;
        
        uint256 amountPerStrategy = amount / strategies.length;
        for (uint256 i = 0; i < strategies.length; i++) {
            // Update allocation tracking
            if (allocations[strategies[i]][msg.sender] >= amountPerStrategy) {
                allocations[strategies[i]][msg.sender] -= amountPerStrategy;
            } else {
                allocations[strategies[i]][msg.sender] = 0;
            }
            
            // Call withdraw on strategy (which queues if needed)
            IStrategy(strategies[i]).withdraw(amountPerStrategy);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DISABLE STANDARD ERC4626 WITHDRAWALS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Standard withdraw is disabled - use requestWithdrawal instead
     */
    function withdraw(uint256, address, address) public pure override returns (uint256) {
        revert("Use requestWithdrawal()");
    }

    /**
     * @notice Standard redeem is disabled - use requestWithdrawal instead
     */
    function redeem(uint256, address, address) public pure override returns (uint256) {
        revert("Use requestWithdrawal()");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STRATEGY MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    function registerStrategy(address strategyId) public onlyOwner {
        require(!isStrategy[strategyId], "Already registered");
        require(strategyId != address(0), "Invalid address");
        
        strategies.push(strategyId);
        isStrategy[strategyId] = true;
        
        // Approve strategy to spend vault funds
        IERC20(asset()).forceApprove(strategyId, type(uint256).max);
        
        emit StrategyRegistered(strategyId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // REWARDS
    // ═══════════════════════════════════════════════════════════════════════════

    function harvest() public {
        uint256 totalCollected;
        for (uint256 i = 0; i < strategies.length; i++) {
            if (isStrategy[strategies[i]]) {
                totalCollected += IStrategy(strategies[i]).claimRewards(address(this));
            }
        }
        
        if (totalCollected > 0 && totalSupply() > 0) {
            accRewardPerShare += (totalCollected * REWARD_PRECISION) / totalSupply();
        }
    }

    function claimAllRewards() external {
        harvest();
        _settleRewards(msg.sender);
        rewardDebt[msg.sender] = (balanceOf(msg.sender) * accRewardPerShare) / REWARD_PRECISION;
    }
    
    function _settleRewards(address user) internal {
        if (balanceOf(user) == 0) return;
        
        uint256 pending = (balanceOf(user) * accRewardPerShare) / REWARD_PRECISION;
        if (pending > rewardDebt[user]) {
            uint256 reward = pending - rewardDebt[user];
            uint256 vaultBalance = IERC20(asset()).balanceOf(address(this));
            // Don't use funds reserved for withdrawals
            uint256 availableForRewards = vaultBalance > totalFulfilledUnclaimed 
                ? vaultBalance - totalFulfilledUnclaimed 
                : 0;
            if (reward > 0 && availableForRewards >= reward) {
                IERC20(asset()).safeTransfer(user, reward);
            }
        }
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0)) {
            _settleRewards(from);
        }
        if (to != address(0)) {
            _settleRewards(to);
        }
        
        super._update(from, to, value);
        
        if (from != address(0)) {
            rewardDebt[from] = (balanceOf(from) * accRewardPerShare) / REWARD_PRECISION;
        }
        if (to != address(0)) {
            rewardDebt[to] = (balanceOf(to) * accRewardPerShare) / REWARD_PRECISION;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    function totalAssets() public view override returns (uint256) {
        uint256 total = IERC20(asset()).balanceOf(address(this));
        // Subtract funds reserved for fulfilled withdrawals
        if (total > totalFulfilledUnclaimed) {
            total -= totalFulfilledUnclaimed;
        } else {
            total = 0;
        }
        // Add strategy assets
        for (uint256 i = 0; i < strategies.length; i++) {
            total += IStrategy(strategies[i]).totalAssets();
        }
        return total;
    }

    function getWithdrawalRequest(uint256 requestId) external view returns (WithdrawalRequest memory) {
        return withdrawalRequests[requestId];
    }

    function getUserPendingWithdrawals(address user) external view returns (uint256) {
        return userPendingWithdrawals[user];
    }

    function getStrategiesCount() external view returns (uint256) {
        return strategies.length;
    }

    /**
     * @notice Get all pending (unfulfilled) withdrawal requests
     */
    function getPendingRequests() external view returns (WithdrawalRequest[] memory) {
        // Count pending
        uint256 count = 0;
        for (uint256 i = 0; i < nextWithdrawalId; i++) {
            if (!withdrawalRequests[i].fulfilled && !withdrawalRequests[i].claimed && 
                withdrawalRequests[i].user != address(0)) {
                count++;
            }
        }
        
        // Build array
        WithdrawalRequest[] memory pending = new WithdrawalRequest[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < nextWithdrawalId; i++) {
            if (!withdrawalRequests[i].fulfilled && !withdrawalRequests[i].claimed &&
                withdrawalRequests[i].user != address(0)) {
                pending[idx++] = withdrawalRequests[i];
            }
        }
        
        return pending;
    }

    /**
     * @notice Get user's claimable (fulfilled but not claimed) requests
     */
    function getUserClaimableRequests(address user) external view returns (WithdrawalRequest[] memory) {
        // Count claimable
        uint256 count = 0;
        for (uint256 i = 0; i < nextWithdrawalId; i++) {
            if (withdrawalRequests[i].user == user && 
                withdrawalRequests[i].fulfilled && 
                !withdrawalRequests[i].claimed) {
                count++;
            }
        }
        
        // Build array
        WithdrawalRequest[] memory claimable = new WithdrawalRequest[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < nextWithdrawalId; i++) {
            if (withdrawalRequests[i].user == user && 
                withdrawalRequests[i].fulfilled && 
                !withdrawalRequests[i].claimed) {
                claimable[idx++] = withdrawalRequests[i];
            }
        }
        
        return claimable;
    }
}
