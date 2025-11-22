// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/BloomStrategyVault.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockStrategy is IStrategy {
    IERC20 public asset;
    uint256 public totalAssetsHeld;
    uint256 public rewardsPerClaim = 10 ether;
    
    constructor(IERC20 _asset) {
        asset = _asset;
    }

    function deposit(uint256 amount) external {
        // Simulate pulling funds from Vault.
        // In tests with SafeTransfer removed from Vault, strategy MUST pull.
        asset.transferFrom(msg.sender, address(this), amount);
        totalAssetsHeld += amount;
    }

    function withdraw(uint256 amount) external {
        require(totalAssetsHeld >= amount, "Insufficient funds");
        totalAssetsHeld -= amount;
        asset.transfer(msg.sender, amount);
    }

    function claimRewards(address recipient) external returns (uint256) {
        // Mint or transfer rewards (mocking by minting directly to user if this were a reward token)
        // Here we just simulate sending more of the underlying 'asset' as a reward for simplicity,
        // or assume we have funds. Let's assume the strategy has extra funds from somewhere.
        // For testing, we'll just 'say' we sent it, or check calls.
        // To be realistic, let's mint a separate RewardToken to the user.
        return rewardsPerClaim;
    }

    function totalAssets() external view returns (uint256) {
        return totalAssetsHeld;
    }
}

contract MockRewardStrategy is IStrategy {
    IERC20 public asset;
    MockERC20 public rewardToken;
    uint256 public totalAssetsHeld;

    constructor(IERC20 _asset) {
        asset = _asset;
        rewardToken = new MockERC20("Reward", "RWD");
    }

    function deposit(uint256 amount) external {
        // Simulate pulling funds from Vault.
        // In tests with SafeTransfer removed from Vault, strategy MUST pull.
        asset.transferFrom(msg.sender, address(this), amount);
        totalAssetsHeld += amount;
    }

    function withdraw(uint256 amount) external {
        totalAssetsHeld -= amount;
        asset.transfer(msg.sender, amount);
    }

    function claimRewards(address recipient) external returns (uint256) {
        // Simulate earning yield in the underlying asset (e.g. USDC)
        // We assume the strategy has generated this yield somehow.
        // For the test, we mint new tokens to the strategy to pay out.
        MockERC20(address(asset)).mint(address(this), 50 ether);
        
        // Send the yield to the Vault (recipient)
        asset.transfer(recipient, 50 ether);
        
        return 50 ether;
    }

    function totalAssets() external view returns (uint256) {
        return totalAssetsHeld;
    }
}

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract BloomStrategyVaultTest is Test {
    BloomStrategyVault public vault;
    MockERC20 public asset;
    MockRewardStrategy public strategy;
    address public user = address(0xBEEF);

    function setUp() public {
        asset = new MockERC20("USDC", "USDC");
        asset.mint(user, 1000 ether);
        
        strategy = new MockRewardStrategy(asset);
        vault = new BloomStrategyVault(asset, address(strategy));
        
        // Approve vault to spend user's asset
        vm.prank(user);
        asset.approve(address(vault), type(uint256).max);
    }

    function testDepositAllocatesToStrategy() public {
        vm.prank(user);
        vault.deposit(100 ether, user);
        
        assertEq(strategy.totalAssets(), 100 ether);
        assertEq(vault.totalAssets(), 100 ether);
    }

    function testWithdrawPullsFromStrategy() public {
        vm.prank(user);
        vault.deposit(100 ether, user);
        
        vm.prank(user);
        vault.withdraw(50 ether, user, user);
        
        assertEq(strategy.totalAssets(), 50 ether);
        assertEq(asset.balanceOf(user), 950 ether);
    }

    function testClaimAllRewards() public {
        vm.prank(user);
        vault.deposit(100 ether, user);
        
        // Vault should verify it received rewards?
        // The Vault distributes rewards in the ASSET token (USDC), not a separate token.
        
        uint256 userBalanceBefore = asset.balanceOf(user);
        
        vm.prank(user);
        vault.claimAllRewards();
        
        uint256 userBalanceAfter = asset.balanceOf(user);
        
        // Should have received 50 ether in rewards (USDC)
        assertEq(userBalanceAfter - userBalanceBefore, 50 ether);
        
        // Principal should be untouched (100 ether deposited, 900 remaining initially)
        // Strategy total assets should be 100.
        assertEq(strategy.totalAssets(), 100 ether);
    }
}

