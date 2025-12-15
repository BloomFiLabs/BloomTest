// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IStrategy.sol";

/**
 * @title KeeperStrategyManager
 * @notice Bridge between BloomStrategyVault and off-chain keeper bot for funding arbitrage
 * @dev Manages capital deployment, withdrawal queuing, and NAV-based accounting
 * 
 * Flow:
 * 1. Vault deposits USDC -> Contract emits CapitalDeployed -> Keeper bridges to exchanges
 * 2. Keeper reports NAV periodically for accurate share pricing
 * 3. Vault withdraws -> If idle funds available, immediate; else queued (1hr deadline)
 * 4. Keeper fulfills withdrawal requests by sending USDC back
 */
contract KeeperStrategyManager is IStrategy, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════════

    struct WithdrawalRequest {
        uint256 id;
        uint256 amount;
        uint256 requestedAt;
        uint256 deadline;
        bool fulfilled;
        bool cancelled;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice The vault that owns this strategy
    address public immutable vault;

    /// @notice The asset token (USDC)
    IERC20 public immutable asset;

    /// @notice Authorized keeper address (can fulfill withdrawals, report NAV)
    address public keeper;

    /// @notice Total principal deployed to keeper (excludes profits)
    uint256 public deployedCapital;

    /// @notice Last reported Net Asset Value from keeper
    uint256 public lastReportedNAV;

    /// @notice Timestamp of last NAV report
    uint256 public lastNAVTimestamp;

    /// @notice Total amount pending in withdrawal queue
    uint256 public pendingWithdrawals;

    /// @notice Maximum age for NAV before considered stale (4 hours)
    uint256 public constant MAX_NAV_AGE = 4 hours;

    /// @notice Withdrawal fulfillment deadline (1 hour)
    uint256 public constant WITHDRAWAL_DEADLINE = 1 hours;

    /// @notice Target idle buffer percentage (10% = 1000 basis points)
    uint256 public idleBufferBps = 1000;

    /// @notice Basis points scale
    uint256 public constant BPS_SCALE = 10000;

    /// @notice Counter for deployment IDs
    uint256 public nextDeploymentId;

    /// @notice Counter for withdrawal request IDs
    uint256 public nextWithdrawalId;

    /// @notice Withdrawal requests queue
    WithdrawalRequest[] public withdrawalQueue;

    /// @notice Emergency mode flag - blocks new deposits
    bool public emergencyMode;

    /// @notice Accumulated rewards ready to be claimed
    uint256 public accumulatedRewards;

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Emitted when capital is deposited and ready for deployment
    event CapitalDeployed(uint256 indexed deploymentId, uint256 amount, uint256 timestamp);

    /// @notice Emitted when a withdrawal is requested and queued
    event WithdrawalRequested(
        uint256 indexed requestId,
        uint256 amount,
        uint256 deadline,
        uint256 timestamp
    );

    /// @notice Emitted when a withdrawal request is fulfilled by keeper
    event WithdrawalFulfilled(uint256 indexed requestId, uint256 amount, uint256 timestamp);

    /// @notice Emitted when a withdrawal is processed immediately from idle funds
    event ImmediateWithdrawal(uint256 amount, uint256 timestamp);

    /// @notice Emitted when keeper reports NAV
    event NAVReported(uint256 nav, int256 pnl, uint256 timestamp);

    /// @notice Emitted when rewards are claimed
    event RewardsClaimed(address indexed recipient, uint256 amount);

    /// @notice Emitted when emergency recall is triggered
    event EmergencyRecall(uint256 totalDeployed, uint256 deadline, uint256 timestamp);

    /// @notice Emitted when keeper withdraws funds for deployment
    event CapitalWithdrawnToKeeper(uint256 amount, uint256 timestamp);

    /// @notice Emitted when keeper is changed
    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);

    /// @notice Emitted when idle buffer is updated
    event IdleBufferUpdated(uint256 oldBps, uint256 newBps);

    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error OnlyVault();
    error OnlyKeeper();
    error ZeroAmount();
    error ZeroAddress();
    error EmergencyModeActive();
    error NAVStale();
    error InvalidRequestId();
    error RequestAlreadyFulfilled();
    error RequestCancelled();
    error RequestExpired();
    error InsufficientFunds();
    error InvalidIdleBuffer();

    // ═══════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert OnlyKeeper();
        _;
    }

    modifier notEmergency() {
        if (emergencyMode) revert EmergencyModeActive();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @param _vault Address of the BloomStrategyVault
     * @param _asset Address of the asset token (USDC)
     * @param _keeper Initial keeper address
     */
    constructor(
        address _vault,
        address _asset,
        address _keeper
    ) Ownable(msg.sender) {
        if (_vault == address(0)) revert ZeroAddress();
        if (_asset == address(0)) revert ZeroAddress();
        if (_keeper == address(0)) revert ZeroAddress();

        vault = _vault;
        asset = IERC20(_asset);
        keeper = _keeper;

        // Initialize NAV timestamp to prevent stale check on first report
        lastNAVTimestamp = block.timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VAULT INTERFACE (IStrategy)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit funds from vault
     * @param amount Amount of USDC to deposit
     * @dev Pulls funds from vault, updates deployed capital, emits event for keeper
     */
    function deposit(uint256 amount) external override onlyVault notEmergency nonReentrant {
        if (amount == 0) revert ZeroAmount();

        // Pull funds from vault
        asset.safeTransferFrom(vault, address(this), amount);

        // Update deployed capital
        deployedCapital += amount;

        // Update NAV to include new capital
        lastReportedNAV += amount;

        // Emit event for keeper to pick up
        uint256 deploymentId = nextDeploymentId++;
        emit CapitalDeployed(deploymentId, amount, block.timestamp);
    }

    /**
     * @notice Withdraw funds to vault
     * @param amount Amount of USDC to withdraw
     * @dev If idle funds available, transfers immediately. Otherwise queues request.
     */
    function withdraw(uint256 amount) external override onlyVault nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 idleBalance = asset.balanceOf(address(this));

        // Try immediate withdrawal from idle funds
        if (idleBalance >= amount) {
            asset.safeTransfer(vault, amount);
            
            // Update deployed capital (withdrawing principal)
            if (deployedCapital >= amount) {
                deployedCapital -= amount;
            } else {
                deployedCapital = 0;
            }

            // Update NAV
            if (lastReportedNAV >= amount) {
                lastReportedNAV -= amount;
            } else {
                lastReportedNAV = 0;
            }

            emit ImmediateWithdrawal(amount, block.timestamp);
            return;
        }

        // Queue withdrawal request for keeper to fulfill
        uint256 requestId = nextWithdrawalId++;
        uint256 deadline = block.timestamp + WITHDRAWAL_DEADLINE;

        withdrawalQueue.push(WithdrawalRequest({
            id: requestId,
            amount: amount,
            requestedAt: block.timestamp,
            deadline: deadline,
            fulfilled: false,
            cancelled: false
        }));

        pendingWithdrawals += amount;

        emit WithdrawalRequested(requestId, amount, deadline, block.timestamp);
    }

    /**
     * @notice Claim accumulated rewards/profits
     * @param recipient Address to receive rewards
     * @return rewardAmount Amount of rewards claimed
     * @dev Calculates profit as NAV - deployedCapital, sends to recipient
     */
    function claimRewards(address recipient) external override onlyVault nonReentrant returns (uint256 rewardAmount) {
        if (recipient == address(0)) revert ZeroAddress();

        // Calculate profit: NAV - deployed capital
        // Profit accumulates when NAV > deployedCapital
        if (lastReportedNAV > deployedCapital) {
            uint256 profit = lastReportedNAV - deployedCapital;
            
            // Check how much is actually available as idle funds
            uint256 idleBalance = asset.balanceOf(address(this));
            
            // Can only claim what's actually in the contract
            rewardAmount = profit > idleBalance ? idleBalance : profit;
            
            if (rewardAmount > 0) {
                // Update NAV to reflect claimed rewards
                lastReportedNAV -= rewardAmount;
                
                asset.safeTransfer(recipient, rewardAmount);
                emit RewardsClaimed(recipient, rewardAmount);
            }
        }

        return rewardAmount;
    }

    /**
     * @notice Get total assets managed by this strategy
     * @return Total NAV (includes principal + unrealized profit)
     * @dev Returns lastReportedNAV. Reverts if NAV is stale (>4 hours old)
     */
    function totalAssets() external view override returns (uint256) {
        // In emergency mode, return only idle balance
        if (emergencyMode) {
            return asset.balanceOf(address(this));
        }

        // Check NAV staleness (allow some grace for initial deployment)
        if (lastReportedNAV > 0 && block.timestamp > lastNAVTimestamp + MAX_NAV_AGE) {
            revert NAVStale();
        }

        return lastReportedNAV;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // KEEPER INTERFACE
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Report current NAV from keeper
     * @param nav Total equity value across all exchanges
     * @dev Called periodically by keeper to update share pricing
     */
    function reportNAV(uint256 nav) external onlyKeeper {
        int256 pnl = int256(nav) - int256(deployedCapital);
        
        lastReportedNAV = nav;
        lastNAVTimestamp = block.timestamp;

        emit NAVReported(nav, pnl, block.timestamp);
    }

    /**
     * @notice Withdraw funds to keeper for deployment on exchanges
     * @param amount Amount of USDC to withdraw
     * @dev Keeper calls this to get funds after CapitalDeployed event
     *      Cannot withdraw more than available (idle - pending withdrawals)
     */
    function withdrawToKeeper(uint256 amount) external onlyKeeper nonReentrant {
        if (amount == 0) revert ZeroAmount();
        
        uint256 idleBalance = asset.balanceOf(address(this));
        uint256 reservedForWithdrawals = pendingWithdrawals;
        uint256 available = idleBalance > reservedForWithdrawals 
            ? idleBalance - reservedForWithdrawals 
            : 0;
        
        if (amount > available) revert InsufficientFunds();
        
        // Transfer to keeper
        asset.safeTransfer(keeper, amount);
        
        emit CapitalWithdrawnToKeeper(amount, block.timestamp);
    }

    /**
     * @notice Fulfill a withdrawal request
     * @param requestId ID of the withdrawal request to fulfill
     * @dev Keeper must send USDC to this contract before calling, or include in same tx
     */
    function fulfillWithdrawal(uint256 requestId) external onlyKeeper nonReentrant {
        if (requestId >= withdrawalQueue.length) revert InvalidRequestId();

        WithdrawalRequest storage request = withdrawalQueue[requestId];
        
        if (request.fulfilled) revert RequestAlreadyFulfilled();
        if (request.cancelled) revert RequestCancelled();

        uint256 amount = request.amount;
        uint256 idleBalance = asset.balanceOf(address(this));
        
        if (idleBalance < amount) revert InsufficientFunds();

        // Mark as fulfilled
        request.fulfilled = true;
        pendingWithdrawals -= amount;

        // Update deployed capital
        if (deployedCapital >= amount) {
            deployedCapital -= amount;
        } else {
            deployedCapital = 0;
        }

        // Update NAV
        if (lastReportedNAV >= amount) {
            lastReportedNAV -= amount;
        } else {
            lastReportedNAV = 0;
        }

        // Transfer to vault
        asset.safeTransfer(vault, amount);

        emit WithdrawalFulfilled(requestId, amount, block.timestamp);
    }

    /**
     * @notice Batch fulfill multiple withdrawal requests
     * @param requestIds Array of request IDs to fulfill
     */
    function fulfillWithdrawalBatch(uint256[] calldata requestIds) external onlyKeeper nonReentrant {
        uint256 totalAmount = 0;

        // First pass: validate all requests and calculate total
        for (uint256 i = 0; i < requestIds.length; i++) {
            uint256 requestId = requestIds[i];
            if (requestId >= withdrawalQueue.length) revert InvalidRequestId();

            WithdrawalRequest storage request = withdrawalQueue[requestId];
            if (request.fulfilled) revert RequestAlreadyFulfilled();
            if (request.cancelled) revert RequestCancelled();

            totalAmount += request.amount;
        }

        uint256 idleBalance = asset.balanceOf(address(this));
        if (idleBalance < totalAmount) revert InsufficientFunds();

        // Second pass: mark all as fulfilled
        for (uint256 i = 0; i < requestIds.length; i++) {
            WithdrawalRequest storage request = withdrawalQueue[requestIds[i]];
            request.fulfilled = true;
            
            emit WithdrawalFulfilled(request.id, request.amount, block.timestamp);
        }

        pendingWithdrawals -= totalAmount;

        // Update deployed capital
        if (deployedCapital >= totalAmount) {
            deployedCapital -= totalAmount;
        } else {
            deployedCapital = 0;
        }

        // Update NAV
        if (lastReportedNAV >= totalAmount) {
            lastReportedNAV -= totalAmount;
        } else {
            lastReportedNAV = 0;
        }

        // Transfer total to vault
        asset.safeTransfer(vault, totalAmount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Update keeper address
     * @param newKeeper New keeper address
     */
    function setKeeper(address newKeeper) external onlyOwner {
        if (newKeeper == address(0)) revert ZeroAddress();
        
        address oldKeeper = keeper;
        keeper = newKeeper;
        
        emit KeeperUpdated(oldKeeper, newKeeper);
    }

    /**
     * @notice Update idle buffer percentage
     * @param newBps New buffer in basis points (e.g., 1000 = 10%)
     */
    function setIdleBuffer(uint256 newBps) external onlyOwner {
        if (newBps > BPS_SCALE) revert InvalidIdleBuffer();
        
        uint256 oldBps = idleBufferBps;
        idleBufferBps = newBps;
        
        emit IdleBufferUpdated(oldBps, newBps);
    }

    /**
     * @notice Trigger emergency recall - requests all funds back from keeper
     * @dev Sets emergency mode, blocking new deposits
     */
    function emergencyRecall() external onlyOwner {
        emergencyMode = true;
        
        uint256 deadline = block.timestamp + WITHDRAWAL_DEADLINE;
        
        emit EmergencyRecall(deployedCapital, deadline, block.timestamp);
    }

    /**
     * @notice Exit emergency mode after funds recovered
     */
    function exitEmergencyMode() external onlyOwner {
        emergencyMode = false;
    }

    /**
     * @notice Cancel an expired withdrawal request
     * @param requestId ID of request to cancel
     * @dev Only callable after deadline has passed
     */
    function cancelExpiredRequest(uint256 requestId) external onlyOwner {
        if (requestId >= withdrawalQueue.length) revert InvalidRequestId();

        WithdrawalRequest storage request = withdrawalQueue[requestId];
        
        if (request.fulfilled) revert RequestAlreadyFulfilled();
        if (request.cancelled) revert RequestCancelled();
        if (block.timestamp <= request.deadline) revert RequestExpired();

        request.cancelled = true;
        pendingWithdrawals -= request.amount;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Get current idle balance
     * @return Amount of USDC held in contract
     */
    function getIdleBalance() external view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /**
     * @notice Get target idle balance based on buffer percentage
     * @return Target idle amount
     */
    function getTargetIdleBalance() external view returns (uint256) {
        return (deployedCapital * idleBufferBps) / BPS_SCALE;
    }

    /**
     * @notice Get number of withdrawal requests
     * @return Length of withdrawal queue
     */
    function getWithdrawalQueueLength() external view returns (uint256) {
        return withdrawalQueue.length;
    }

    /**
     * @notice Get withdrawal request by ID
     * @param requestId Request ID
     * @return The withdrawal request struct
     */
    function getWithdrawalRequest(uint256 requestId) external view returns (WithdrawalRequest memory) {
        if (requestId >= withdrawalQueue.length) revert InvalidRequestId();
        return withdrawalQueue[requestId];
    }

    /**
     * @notice Get all pending (unfulfilled, not cancelled) withdrawal requests
     * @return requests Array of pending requests
     */
    function getPendingWithdrawals() external view returns (WithdrawalRequest[] memory) {
        uint256 pendingCount = 0;
        
        // Count pending requests
        for (uint256 i = 0; i < withdrawalQueue.length; i++) {
            if (!withdrawalQueue[i].fulfilled && !withdrawalQueue[i].cancelled) {
                pendingCount++;
            }
        }

        // Build array
        WithdrawalRequest[] memory requests = new WithdrawalRequest[](pendingCount);
        uint256 index = 0;
        
        for (uint256 i = 0; i < withdrawalQueue.length; i++) {
            if (!withdrawalQueue[i].fulfilled && !withdrawalQueue[i].cancelled) {
                requests[index] = withdrawalQueue[i];
                index++;
            }
        }

        return requests;
    }

    /**
     * @notice Check if NAV is stale
     * @return True if NAV is older than MAX_NAV_AGE
     */
    function isNAVStale() external view returns (bool) {
        return block.timestamp > lastNAVTimestamp + MAX_NAV_AGE;
    }

    /**
     * @notice Get current profit/loss
     * @return pnl Signed profit/loss value
     */
    function getCurrentPnL() external view returns (int256 pnl) {
        return int256(lastReportedNAV) - int256(deployedCapital);
    }

    /**
     * @notice Get strategy summary
     * @return _deployedCapital Total deployed principal
     * @return _lastReportedNAV Current NAV
     * @return _pendingWithdrawals Total pending withdrawals
     * @return _idleBalance Current idle balance
     * @return _pnl Current profit/loss
     */
    function getStrategySummary() external view returns (
        uint256 _deployedCapital,
        uint256 _lastReportedNAV,
        uint256 _pendingWithdrawals,
        uint256 _idleBalance,
        int256 _pnl
    ) {
        return (
            deployedCapital,
            lastReportedNAV,
            pendingWithdrawals,
            asset.balanceOf(address(this)),
            int256(lastReportedNAV) - int256(deployedCapital)
        );
    }
}

