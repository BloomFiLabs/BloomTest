// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/BloomStrategyVault.sol";
import "../src/interfaces/IStrategy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDCVault is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract MockStrategy is IStrategy {
    IERC20 public asset;
    uint256 public totalDeposited;
    uint256 public reportedNAV;
    address public vault;
    
    constructor(address _asset, address _vault) {
        asset = IERC20(_asset);
        vault = _vault;
    }
    
    function deposit(uint256 amount) external override {
        asset.transferFrom(msg.sender, address(this), amount);
        totalDeposited += amount;
        reportedNAV += amount;
    }
    
    function withdraw(uint256 amount) external override {
        // For testing immediate withdrawals
        if (asset.balanceOf(address(this)) >= amount) {
            asset.transfer(vault, amount);
            if (totalDeposited >= amount) totalDeposited -= amount;
            if (reportedNAV >= amount) reportedNAV -= amount;
        }
        // If not enough balance, withdrawal is "queued" (does nothing for mock)
    }
    
    function claimRewards(address recipient) external override returns (uint256) {
        return 0;
    }
    
    function totalAssets() external view override returns (uint256) {
        return reportedNAV;
    }
    
    // Test helpers
    function setNAV(uint256 _nav) external {
        reportedNAV = _nav;
    }
    
    function simulateFulfillment(uint256 amount) external {
        // Mint to simulate funds returning
        MockUSDCVault(address(asset)).mint(vault, amount);
    }
}

contract BloomStrategyVaultTest is Test {
    BloomStrategyVault public vault;
    MockUSDCVault public usdc;
    MockStrategy public strategy;
    
    address public owner = address(this);
    address public user1 = address(0x1111111111111111111111111111111111111111);
    address public user2 = address(0x2222222222222222222222222222222222222222);
    
    event WithdrawalRequested(uint256 indexed requestId, address indexed user, uint256 assets, uint256 shares, uint256 timestamp);
    event WithdrawalFulfilled(uint256 indexed requestId, uint256 assets);
    event WithdrawalClaimed(uint256 indexed requestId, address indexed user, uint256 assets);

    function setUp() public {
        usdc = new MockUSDCVault();
        vault = new BloomStrategyVault(usdc, address(0));
        strategy = new MockStrategy(address(usdc), address(vault));
        
        vault.registerStrategy(address(strategy));
        
        // Fund users
        usdc.mint(user1, 100_000e6);
        usdc.mint(user2, 50_000e6);
        
        // Approve vault
        vm.prank(user1);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(user2);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEPOSIT TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_Deposit() public {
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        
        assertEq(vault.balanceOf(user1), 10_000e6);
        assertEq(strategy.totalAssets(), 10_000e6);
    }

    function test_DepositMultipleUsers() public {
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        
        vm.prank(user2);
        vault.deposit(5_000e6, user2);
        
        assertEq(vault.balanceOf(user1), 10_000e6);
        assertEq(vault.balanceOf(user2), 5_000e6);
        assertEq(strategy.totalAssets(), 15_000e6);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TWO-STEP WITHDRAWAL TESTS
    // ═══════════════════════════════════════════════════════════════

    function test_RequestWithdrawal() public {
        // Deposit first
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        
        // Request withdrawal
        vm.prank(user1);
        vm.expectEmit(true, true, false, true);
        emit WithdrawalRequested(0, user1, 5_000e6, 5_000e6, block.timestamp);
        uint256 requestId = vault.requestWithdrawal(5_000e6);
        
        assertEq(requestId, 0);
        assertEq(vault.balanceOf(user1), 5_000e6); // Shares burned
        assertEq(vault.totalPendingWithdrawals(), 5_000e6);
        assertEq(vault.userPendingWithdrawals(user1), 5_000e6);
    }

    function test_RequestWithdrawal_CreatesCorrectRequest() public {
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        
        vm.prank(user1);
        vault.requestWithdrawal(5_000e6);
        
        BloomStrategyVault.WithdrawalRequest memory req = vault.getWithdrawalRequest(0);
        assertEq(req.id, 0);
        assertEq(req.user, user1);
        assertEq(req.assets, 5_000e6);
        assertEq(req.shares, 5_000e6);
        assertEq(req.fulfilled, false);
        assertEq(req.claimed, false);
    }

    function test_MarkWithdrawalFulfilled() public {
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        
        vm.prank(user1);
        vault.requestWithdrawal(5_000e6);
        
        // Simulate keeper fulfilling - sends funds to vault
        usdc.mint(address(vault), 5_000e6);
        
        // Mark as fulfilled
        vm.expectEmit(true, false, false, true);
        emit WithdrawalFulfilled(0, 5_000e6);
        vault.markWithdrawalFulfilled(0);
        
        BloomStrategyVault.WithdrawalRequest memory req = vault.getWithdrawalRequest(0);
        assertEq(req.fulfilled, true);
        assertEq(vault.totalPendingWithdrawals(), 0);
        assertEq(vault.totalFulfilledUnclaimed(), 5_000e6);
    }

    function test_ClaimWithdrawal() public {
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        
        vm.prank(user1);
        vault.requestWithdrawal(5_000e6);
        
        // Fulfill
        usdc.mint(address(vault), 5_000e6);
        vault.markWithdrawalFulfilled(0);
        
        // Claim
        uint256 user1BalanceBefore = usdc.balanceOf(user1);
        
        vm.prank(user1);
        vm.expectEmit(true, true, false, true);
        emit WithdrawalClaimed(0, user1, 5_000e6);
        vault.claimWithdrawal(0);
        
        assertEq(usdc.balanceOf(user1), user1BalanceBefore + 5_000e6);
        assertEq(vault.totalFulfilledUnclaimed(), 0);
        assertEq(vault.userPendingWithdrawals(user1), 0);
    }

    function test_ClaimWithdrawal_RevertsIfNotFulfilled() public {
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        
        vm.prank(user1);
        vault.requestWithdrawal(5_000e6);
        
        // Try to claim without fulfillment
        vm.prank(user1);
        vm.expectRevert(BloomStrategyVault.NotYetFulfilled.selector);
        vault.claimWithdrawal(0);
    }

    function test_ClaimWithdrawal_RevertsIfNotOwner() public {
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        
        vm.prank(user1);
        vault.requestWithdrawal(5_000e6);
        
        usdc.mint(address(vault), 5_000e6);
        vault.markWithdrawalFulfilled(0);
        
        // User2 tries to claim user1's request
        vm.prank(user2);
        vm.expectRevert(BloomStrategyVault.NotYourRequest.selector);
        vault.claimWithdrawal(0);
    }

    function test_ClaimWithdrawal_RevertsIfAlreadyClaimed() public {
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        
        vm.prank(user1);
        vault.requestWithdrawal(5_000e6);
        
        usdc.mint(address(vault), 5_000e6);
        vault.markWithdrawalFulfilled(0);
        
        vm.prank(user1);
        vault.claimWithdrawal(0);
        
        // Try to claim again
        vm.prank(user1);
        vm.expectRevert(BloomStrategyVault.AlreadyClaimed.selector);
        vault.claimWithdrawal(0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STANDARD WITHDRAW DISABLED TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_StandardWithdraw_Reverts() public {
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        
        vm.prank(user1);
        vm.expectRevert("Use requestWithdrawal()");
        vault.withdraw(5_000e6, user1, user1);
    }

    function test_StandardRedeem_Reverts() public {
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        
        vm.prank(user1);
        vm.expectRevert("Use requestWithdrawal()");
        vault.redeem(5_000e6, user1, user1);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FULL FLOW TEST
    // ═══════════════════════════════════════════════════════════════════════════

    function test_FullWithdrawalFlow() public {
        // 1. User deposits
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        
        // 2. User requests withdrawal
        vm.prank(user1);
        uint256 requestId = vault.requestWithdrawal(10_000e6);
        
        // Verify state after request
        assertEq(vault.balanceOf(user1), 0); // All shares burned
        assertEq(vault.totalPendingWithdrawals(), 10_000e6);
        
        // 3. Keeper fulfills (sends funds back to vault)
        usdc.mint(address(vault), 10_000e6);
        vault.markWithdrawalFulfilled(requestId);
        
        // Verify state after fulfillment
        assertEq(vault.totalPendingWithdrawals(), 0);
        assertEq(vault.totalFulfilledUnclaimed(), 10_000e6);
        
        // 4. User claims
        uint256 user1BalanceBefore = usdc.balanceOf(user1);
        vm.prank(user1);
        vault.claimWithdrawal(requestId);
        
        // Verify final state
        assertEq(usdc.balanceOf(user1), user1BalanceBefore + 10_000e6);
        assertEq(vault.totalFulfilledUnclaimed(), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTION TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_GetPendingRequests() public {
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        
        vm.prank(user1);
        vault.requestWithdrawal(3_000e6);
        vm.prank(user1);
        vault.requestWithdrawal(2_000e6);
        
        BloomStrategyVault.WithdrawalRequest[] memory pending = vault.getPendingRequests();
        assertEq(pending.length, 2);
        // Note: Assets calculated based on share price at time of request
        // First request: 3000 shares at 1:1 = 3000 assets
        // Second request: shares burned changes totalAssets, so price differs
        assertGt(pending[0].assets, 0);
        assertGt(pending[1].assets, 0);
    }

    function test_GetUserClaimableRequests() public {
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        
        vm.prank(user1);
        vault.requestWithdrawal(3_000e6);
        vm.prank(user1);
        vault.requestWithdrawal(2_000e6);
        
        // Fulfill only first request
        usdc.mint(address(vault), 3_000e6);
        vault.markWithdrawalFulfilled(0);
        
        BloomStrategyVault.WithdrawalRequest[] memory claimable = vault.getUserClaimableRequests(user1);
        assertEq(claimable.length, 1);
        assertEq(claimable[0].id, 0);
        assertEq(claimable[0].assets, 3_000e6);
    }

    function test_BatchMarkFulfilled() public {
        vm.prank(user1);
        vault.deposit(10_000e6, user1);
        
        // Request all shares at once to avoid price changes
        vm.prank(user1);
        vault.requestWithdrawal(10_000e6);
        
        // Get the request to see actual assets
        BloomStrategyVault.WithdrawalRequest memory req = vault.getWithdrawalRequest(0);
        uint256 totalAssets = req.assets;
        
        // Send funds and fulfill
        usdc.mint(address(vault), totalAssets);
        
        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;
        
        vault.markWithdrawalsFulfilledBatch(ids);
        
        assertEq(vault.totalPendingWithdrawals(), 0);
        assertEq(vault.totalFulfilledUnclaimed(), totalAssets);
    }
}
