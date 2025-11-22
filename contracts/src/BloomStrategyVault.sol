// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IStrategy {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function claimRewards(address recipient) external returns (uint256);
    function totalAssets() external view returns (uint256);
}

contract BloomStrategyVault is ERC4626, Ownable {
    using SafeERC20 for IERC20;

    // Configuration
    mapping(address => mapping(address => uint256)) public usersDeposits; // user -> asset -> amount
    mapping(address => mapping(address => uint256)) public allocations; // strategy -> user -> amount
    
    address[] public strategies;
    mapping(address => bool) public isStrategy;
    
    uint256 public constant BPS_SCALE = 10000;
    
    // Dividend Tracking
    uint256 public accRewardPerShare;
    mapping(address => uint256) public rewardDebt;
    uint256 public constant REWARD_PRECISION = 1e12;

    constructor(
        IERC20 _asset,
        address _initialStrategy // Optional initial strategy
    ) ERC4626(_asset) ERC20("Bloom Strategy Vault", "BSV") Ownable(msg.sender) {
        if (_initialStrategy != address(0)) {
            registerStrategy(_initialStrategy);
        }
    }

    // --------------------------------------------------------
    // ERC4626 Overrides & Core Logic
    // --------------------------------------------------------

    // Standard ERC4626 deposit override to track user deposits and allocate
    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal override {
        // Settle pending rewards for receiver before share balance changes
        _settleRewards(receiver);
        
        super._deposit(caller, receiver, assets, shares);
        
        // Track user deposit for the asset (vault asset)
        usersDeposits[receiver][asset()] += assets;
        
        // Allocate funds to registered strategies
        // Logic: simple even split for now, or could be weighted
        if (strategies.length > 0) {
            uint256 amountPerStrategy = assets / strategies.length;
            address[] memory strats = strategies;
            uint256[] memory amounts = new uint256[](strats.length);
            
            for(uint256 i = 0; i < strats.length; i++) {
                amounts[i] = amountPerStrategy;
            }
            
            allocateToStrategies(receiver, strats, amounts);
        }
        
        // Update debt
        rewardDebt[receiver] = (balanceOf(receiver) * accRewardPerShare) / REWARD_PRECISION;
    }

    // Standard ERC4626 withdraw override to pull funds from strategies
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override {
        // Settle pending rewards for owner before share balance changes
        _settleRewards(owner);

        // 1. Update internal tracking
        if (usersDeposits[owner][asset()] >= assets) {
            usersDeposits[owner][asset()] -= assets;
        } else {
            usersDeposits[owner][asset()] = 0; // Should not happen if shares match assets 1:1 roughly
        }

        // 2. Withdraw from strategies
        // Logic: Withdraw proportionally from all strategies
        if (strategies.length > 0) {
            uint256 amountPerStrategy = assets / strategies.length;
            address[] memory strats = strategies;
            uint256[] memory amounts = new uint256[](strats.length);
             for(uint256 i = 0; i < strats.length; i++) {
                amounts[i] = amountPerStrategy;
            }
            withdrawFromStrategies(owner, strats, amounts);
        }

        super._withdraw(caller, receiver, owner, assets, shares);
        
        // Update debt
        rewardDebt[owner] = (balanceOf(owner) * accRewardPerShare) / REWARD_PRECISION;
    }
    
    function _update(address from, address to, uint256 value) internal override {
        // Hook into transfers to settle rewards
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

    // --------------------------------------------------------
    // Strategy Management
    // --------------------------------------------------------

    function registerStrategy(address strategyId) public onlyOwner {
        require(!isStrategy[strategyId], "Strategy already registered");
        require(strategyId != address(0), "Invalid address");
        strategies.push(strategyId);
        isStrategy[strategyId] = true;
        
        // Approve strategy to spend vault funds
        IERC20(asset()).forceApprove(strategyId, type(uint256).max);
    }

    function allocateToStrategies(address user, address[] memory strategyIds, uint256[] memory amounts) internal {
        require(strategyIds.length == amounts.length, "Length mismatch");
        
        for (uint256 i = 0; i < strategyIds.length; i++) {
            address strat = strategyIds[i];
            require(isStrategy[strat], "Strategy not registered");
            
            allocations[strat][user] += amounts[i];
            
            // Transfer funds to strategy, then strategy handles logic
            // IERC20(asset()).safeTransfer(strat, amounts[i]);
            IStrategy(strat).deposit(amounts[i]);
        }
    }

    function withdrawFromStrategies(address user, address[] memory strategyIds, uint256[] memory amounts) internal {
        require(strategyIds.length == amounts.length, "Length mismatch");

        for (uint256 i = 0; i < strategyIds.length; i++) {
            address strat = strategyIds[i];
            require(isStrategy[strat], "Strategy not registered");
            
            // Update allocation tracking
            if (allocations[strat][user] >= amounts[i]) {
                allocations[strat][user] -= amounts[i];
            } else {
                allocations[strat][user] = 0;
            }

            // Call withdraw on strategy
            // Strategy should send funds back to Vault
            IStrategy(strat).withdraw(amounts[i]);
        }
    }

    // --------------------------------------------------------
    // Rewards & Admin
    // --------------------------------------------------------

    /// @notice Harvests rewards from strategies and updates dividend tracker
    function harvest() public {
        uint256 totalCollected;
        for (uint256 i = 0; i < strategies.length; i++) {
            if (isStrategy[strategies[i]]) {
                // Strategy sends rewards to Vault
                totalCollected += IStrategy(strategies[i]).claimRewards(address(this));
            }
        }
        
        if (totalCollected > 0 && totalSupply() > 0) {
            accRewardPerShare += (totalCollected * REWARD_PRECISION) / totalSupply();
        }
    }

    /// @notice Claims accrued dividends for the caller
    function claimAllRewards() external {
        harvest(); // Optional: harvest before claiming to get latest
        _settleRewards(msg.sender);
        rewardDebt[msg.sender] = (balanceOf(msg.sender) * accRewardPerShare) / REWARD_PRECISION;
    }
    
    function _settleRewards(address user) internal {
        uint256 pending = (balanceOf(user) * accRewardPerShare) / REWARD_PRECISION - rewardDebt[user];
        if (pending > 0) {
            // Safe transfer if we have the tokens (harvested)
            IERC20(asset()).safeTransfer(user, pending);
        }
    }

    // Helper to check total assets across all strategies
    function totalAssets() public view override returns (uint256) {
        uint256 total = IERC20(asset()).balanceOf(address(this));
        for (uint256 i = 0; i < strategies.length; i++) {
            total += IStrategy(strategies[i]).totalAssets();
        }
        return total;
    }
}
