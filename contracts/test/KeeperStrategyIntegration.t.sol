// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/BloomStrategyVault.sol";
import "../src/KeeperStrategyManager.sol";
import "../src/interfaces/IStrategy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice Simple ERC20 mock for testing
 */
contract MockUSDCInt is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/**
 * @title KeeperStrategyIntegrationTest
 * @notice End-to-end integration tests for the full flow:
 *         User -> BloomStrategyVault -> KeeperStrategyManager -> Keeper Bot (simulated)
 */
contract KeeperStrategyIntegrationTest is Test {
    BloomStrategyVault public vault;
    KeeperStrategyManager public strategy;
    MockUSDCInt public usdc;

    address public owner = address(this);
    address public keeper = address(0x2222222222222222222222222222222222222222);
    address public user1 = address(0x1111111111111111111111111111111111111111);
    address public user2 = address(0x3333333333333333333333333333333333333333);

    // Events to verify
    event CapitalDeployed(uint256 indexed deploymentId, uint256 amount, uint256 timestamp);
    event WithdrawalRequested(uint256 indexed requestId, uint256 amount, uint256 deadline, uint256 timestamp);
    event WithdrawalFulfilled(uint256 indexed requestId, uint256 amount, uint256 timestamp);
    event NAVReported(uint256 nav, int256 pnl, uint256 timestamp);

    function setUp() public {
        // Deploy mock USDC
        usdc = new MockUSDCInt();

        // Deploy vault first (without initial strategy)
        vault = new BloomStrategyVault(usdc, address(0));

        // Deploy KeeperStrategyManager
        strategy = new KeeperStrategyManager(address(vault), address(usdc), keeper);

        // Register strategy with vault
        vault.registerStrategy(address(strategy));

        // Fund users
        usdc.mint(user1, 100_000e6); // 100k USDC
        usdc.mint(user2, 50_000e6);  // 50k USDC

        // Approve vault
        vm.prank(user1);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(user2);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FULL DEPOSIT FLOW TEST
    // ═══════════════════════════════════════════════════════════════════════════

    function test_FullDepositFlow() public {
        // Step 1: User deposits to vault
        uint256 depositAmount = 10_000e6;
        
        vm.prank(user1);
        vm.expectEmit(true, false, false, true, address(strategy));
        emit CapitalDeployed(0, depositAmount, block.timestamp);
        vault.deposit(depositAmount, user1);

        // Verify user received shares
        uint256 shares = vault.balanceOf(user1);
        assertGt(shares, 0, "User should have received shares");

        // Verify strategy received funds
        assertEq(strategy.deployedCapital(), depositAmount, "Strategy should track deployed capital");
        assertEq(strategy.lastReportedNAV(), depositAmount, "NAV should equal deposit initially");
        assertEq(usdc.balanceOf(address(strategy)), depositAmount, "Strategy should hold USDC");

        // Verify vault total assets
        assertEq(vault.totalAssets(), depositAmount, "Vault total assets should equal deposit");
    }

    function test_MultipleUsersDeposit() public {
        // User 1 deposits
        vm.prank(user1);
        vault.deposit(10_000e6, user1);

        // User 2 deposits
        vm.prank(user2);
        vault.deposit(5_000e6, user2);

        // Verify totals
        assertEq(strategy.deployedCapital(), 15_000e6, "Total deployed should be 15k");
        assertEq(vault.totalAssets(), 15_000e6, "Vault total should be 15k");

        // Verify proportional shares
        uint256 user1Shares = vault.balanceOf(user1);
        uint256 user2Shares = vault.balanceOf(user2);
        assertEq(user1Shares, user2Shares * 2, "User1 should have 2x shares of User2");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // NAV REPORTING FLOW TEST
    // ═══════════════════════════════════════════════════════════════════════════

    function test_NAVReportingWithProfit() public {
        // Setup: deposit
        vm.prank(user1);
        vault.deposit(10_000e6, user1);

        // Simulate keeper deploying funds to exchanges
        vm.prank(address(strategy));
        usdc.transfer(keeper, 10_000e6);

        // Keeper reports NAV with 10% profit
        uint256 newNAV = 11_000e6;
        vm.prank(keeper);
        vm.expectEmit(false, false, false, true, address(strategy));
        emit NAVReported(newNAV, 1_000e6, block.timestamp);
        strategy.reportNAV(newNAV);

        // Verify NAV updated
        assertEq(strategy.lastReportedNAV(), newNAV, "NAV should be updated");
        assertEq(strategy.getCurrentPnL(), 1_000e6, "PnL should be 1000 USDC");

        // Verify vault reflects new NAV
        assertEq(vault.totalAssets(), newNAV, "Vault should reflect new NAV");
    }

    function test_NAVReportingWithLoss() public {
        // Setup: deposit
        vm.prank(user1);
        vault.deposit(10_000e6, user1);

        vm.prank(address(strategy));
        usdc.transfer(keeper, 10_000e6);

        // Keeper reports NAV with 5% loss
        uint256 newNAV = 9_500e6;
        vm.prank(keeper);
        strategy.reportNAV(newNAV);

        // Verify negative PnL
        assertEq(strategy.getCurrentPnL(), -500e6, "PnL should be -500 USDC");

        // Verify vault reflects loss
        assertEq(vault.totalAssets(), newNAV, "Vault should reflect loss");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TWO-STEP WITHDRAWAL FLOW TEST
    // ═══════════════════════════════════════════════════════════════════════════

    function test_TwoStepWithdrawal() public {
        // Setup: deposit
        vm.prank(user1);
        vault.deposit(10_000e6, user1);

        // Step 1: Request withdrawal
        uint256 shares = vault.balanceOf(user1);
        uint256 sharesToWithdraw = shares / 2;
        
        vm.prank(user1);
        uint256 requestId = vault.requestWithdrawal(sharesToWithdraw);

        // Verify shares were burned
        assertEq(vault.balanceOf(user1), shares - sharesToWithdraw, "Shares should be burned");

        // Get the request to see actual assets
        BloomStrategyVault.WithdrawalRequest memory req = vault.getWithdrawalRequest(requestId);
        uint256 expectedAssets = req.assets;

        // Step 2: Keeper fulfills (simulated by minting USDC to vault)
        usdc.mint(address(vault), expectedAssets);
        vault.markWithdrawalFulfilled(requestId);

        // Step 3: User claims
        uint256 user1BalanceBefore = usdc.balanceOf(user1);
        vm.prank(user1);
        vault.claimWithdrawal(requestId);

        // Verify user received funds
        assertEq(usdc.balanceOf(user1), user1BalanceBefore + expectedAssets, "User should receive USDC");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // QUEUED WITHDRAWAL FULL FLOW TEST
    // ═══════════════════════════════════════════════════════════════════════════

    function test_QueuedWithdrawalFullFlow() public {
        // Setup: deposit
        vm.prank(user1);
        vault.deposit(10_000e6, user1);

        // Simulate keeper taking all funds (deploying to exchanges)
        vm.prank(keeper);
        strategy.withdrawToKeeper(10_000e6);
        
        assertEq(usdc.balanceOf(address(strategy)), 0, "Strategy should have no idle funds");

        // User requests withdrawal - goes through two-step process
        uint256 shares = vault.balanceOf(user1);
        vm.prank(user1);
        uint256 vaultRequestId = vault.requestWithdrawal(shares);

        // Get the request details
        BloomStrategyVault.WithdrawalRequest memory vaultReq = vault.getWithdrawalRequest(vaultRequestId);
        uint256 withdrawAmount = vaultReq.assets;

        // Verify vault request is pending
        assertFalse(vaultReq.fulfilled, "Vault request should not be fulfilled yet");
        assertEq(vault.balanceOf(user1), 0, "User shares should be burned");

        // Strategy should have queued a withdrawal request
        assertEq(strategy.pendingWithdrawals(), withdrawAmount, "Strategy should have pending withdrawal");

        // Keeper sees strategy's WithdrawalRequested event and fulfills
        // First send USDC back to strategy
        usdc.mint(address(strategy), withdrawAmount);
        
        // Fulfill strategy withdrawal (sends to vault)
        vm.prank(keeper);
        strategy.fulfillWithdrawal(0);

        // Verify strategy sent funds to vault
        assertGe(usdc.balanceOf(address(vault)), withdrawAmount, "Vault should have received USDC");

        // Mark vault request as fulfilled
        vault.markWithdrawalFulfilled(vaultRequestId);

        // User claims from vault
        uint256 user1BalanceBefore = usdc.balanceOf(user1);
        vm.prank(user1);
        vault.claimWithdrawal(vaultRequestId);

        // Verify user received funds
        assertEq(usdc.balanceOf(user1), user1BalanceBefore + withdrawAmount, "User should receive USDC");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // REWARDS CLAIM FLOW TEST
    // ═══════════════════════════════════════════════════════════════════════════

    function test_RewardsClaimFlow() public {
        // Setup: deposit
        vm.prank(user1);
        vault.deposit(10_000e6, user1);

        // Simulate keeper deploying funds
        vm.prank(keeper);
        strategy.withdrawToKeeper(10_000e6);

        // Report NAV with 10% profit
        vm.prank(keeper);
        strategy.reportNAV(11_000e6);

        // Keeper sends profit back to strategy
        usdc.mint(address(strategy), 1_000e6);

        // Harvest rewards through vault
        uint256 vaultBalanceBefore = usdc.balanceOf(address(vault));
        vault.harvest();

        // Verify rewards were claimed
        uint256 vaultBalanceAfter = usdc.balanceOf(address(vault));
        assertEq(vaultBalanceAfter, vaultBalanceBefore + 1_000e6, "Vault should have received rewards");

        // User claims their share
        uint256 user1BalanceBefore = usdc.balanceOf(user1);
        vm.prank(user1);
        vault.claimAllRewards();

        // Verify user received rewards
        assertGt(usdc.balanceOf(user1), user1BalanceBefore, "User should receive rewards");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EMERGENCY MODE TEST
    // ═══════════════════════════════════════════════════════════════════════════

    function test_EmergencyMode() public {
        // Setup: deposit
        vm.prank(user1);
        vault.deposit(10_000e6, user1);

        // Trigger emergency recall
        strategy.emergencyRecall();

        // Verify emergency mode
        assertTrue(strategy.emergencyMode(), "Should be in emergency mode");

        // New deposits should fail
        vm.prank(user2);
        vm.expectRevert(KeeperStrategyManager.EmergencyModeActive.selector);
        vault.deposit(1_000e6, user2);

        // Exit emergency mode
        strategy.exitEmergencyMode();
        assertFalse(strategy.emergencyMode(), "Should exit emergency mode");

        // Now deposits should work
        vm.prank(user2);
        vault.deposit(1_000e6, user2);
        assertGt(vault.balanceOf(user2), 0, "Deposit should work after emergency exit");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SHARE PRICING TEST
    // ═══════════════════════════════════════════════════════════════════════════

    function test_SharePricingWithProfitAndLoss() public {
        // Initial deposit at 1:1 pricing
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        uint256 user1Shares = vault.balanceOf(user1);

        // Simulate profit (20%)
        vm.prank(address(strategy));
        usdc.transfer(keeper, 10_000e6);
        vm.prank(keeper);
        strategy.reportNAV(12_000e6);

        // User2 deposits after profit - should get fewer shares
        vm.prank(user2);
        vault.deposit(10_000e6, user2);
        uint256 user2Shares = vault.balanceOf(user2);

        // User2 should have fewer shares since price per share increased
        assertLt(user2Shares, user1Shares, "User2 should get fewer shares after profit");

        // Verify total assets
        assertEq(vault.totalAssets(), 22_000e6, "Total assets should be 22k");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FULL CYCLE TEST
    // ═══════════════════════════════════════════════════════════════════════════

    function test_FullLifecycle() public {
        // 1. Multiple users deposit
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        vm.prank(user2);
        vault.deposit(5_000e6, user2);

        // 2. Keeper deploys capital via withdrawToKeeper
        vm.prank(keeper);
        strategy.withdrawToKeeper(15_000e6);

        // 3. Time passes, keeper reports NAV with profit
        vm.warp(block.timestamp + 1 days);
        vm.prank(keeper);
        strategy.reportNAV(16_500e6); // 10% profit

        // 4. User1 requests withdrawal (two-step process)
        uint256 user1Shares = vault.balanceOf(user1);
        vm.prank(user1);
        uint256 vaultRequestId = vault.requestWithdrawal(user1Shares / 2);
        
        BloomStrategyVault.WithdrawalRequest memory vaultReq = vault.getWithdrawalRequest(vaultRequestId);
        uint256 withdrawAmount = vaultReq.assets;

        // Keeper fulfills - sends funds to strategy then to vault
        usdc.mint(address(strategy), withdrawAmount);
        vm.prank(keeper);
        strategy.fulfillWithdrawal(0);
        
        // Mark vault request as fulfilled
        vault.markWithdrawalFulfilled(vaultRequestId);
        
        // User claims
        uint256 user1BalanceBeforeWithdraw = usdc.balanceOf(user1);
        vm.prank(user1);
        vault.claimWithdrawal(vaultRequestId);
        assertGt(usdc.balanceOf(user1), user1BalanceBeforeWithdraw, "User1 should receive withdrawal");

        // 5. More time passes, keeper reports updated NAV
        vm.warp(block.timestamp + 1 days);
        vm.prank(keeper);
        strategy.reportNAV(12_000e6);

        // 6. Harvest rewards
        usdc.mint(address(strategy), 500e6);
        vault.harvest();

        // 7. User2 claims rewards (user1 has fewer shares now)
        uint256 user2BalanceBefore = usdc.balanceOf(user2);
        vm.prank(user2);
        vault.claimAllRewards();
        assertGt(usdc.balanceOf(user2), user2BalanceBefore, "User2 should receive rewards");

        // 8. Verify final state
        (
            uint256 deployed,
            uint256 nav,
            uint256 pending,
            ,
            int256 pnl
        ) = strategy.getStrategySummary();

        assertGt(nav, 0, "NAV should be positive");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // NAV STALENESS TEST
    // ═══════════════════════════════════════════════════════════════════════════

    function test_NAVStalenessCheck() public {
        // Setup: deposit
        vm.prank(user1);
        vault.deposit(10_000e6, user1);

        // Warp past NAV staleness threshold (4 hours)
        vm.warp(block.timestamp + 5 hours);

        // totalAssets should revert due to stale NAV
        vm.expectRevert(KeeperStrategyManager.NAVStale.selector);
        vault.totalAssets();

        // Report fresh NAV
        vm.prank(keeper);
        strategy.reportNAV(10_000e6);

        // Now should work
        assertEq(vault.totalAssets(), 10_000e6, "Should return fresh NAV");
    }
}

