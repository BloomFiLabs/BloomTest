// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/CollateralManager.sol";

// Interfaces for dealing with tokens on fork
interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

contract CollateralManagerForkTest is Test {
    CollateralManager public manager;
    
    // Base Mainnet Addresses
    address constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // Base USDC
    address constant WETH = 0x4200000000000000000000000000000000000006; // Base WETH
    
    // A whale to impersonate for funding
    address constant USDC_WHALE = 0xd0b53D9277642d899DF5C87A3966A349A798F224; // Uniswap V3 WETH/USDC Pool
    
    function setUp() public {
        // Create the fork
        string memory rpcUrl = "https://base-mainnet.infura.io/v3/5ce3f0a2d7814e3c9da96f8e8ebf4d0c";
        vm.createSelectFork(rpcUrl);
        
        manager = new CollateralManager(AAVE_POOL);
    }

    function testForkDepositAndBorrow() public {
        // 1. Fund a test user with USDC
        address user = address(0x123);
        uint256 depositAmount = 1000 * 1e6; // 1000 USDC
        
        vm.prank(USDC_WHALE);
        IERC20Like(USDC).transfer(user, depositAmount);
        
        vm.startPrank(user);
        
        // Approve manager
        IERC20Like(USDC).approve(address(manager), type(uint256).max);
        
        // 2. Deposit Collateral (USDC)
        CollateralManager.ManageCollateralParams memory params = CollateralManager.ManageCollateralParams({
            asset: USDC,
            collateralPct1e5: 500_000, // 5% (arbitrary identifier for this bucket)
            amountDesired: depositAmount,
            amountMin: 0,
            referralCode: 0
        });
        
        manager.depositCollateral(params);
        
        (uint256 managedAmount, ) = manager.getManagedCollateral(user, USDC, 500_000);
        assertEq(managedAmount, depositAmount, "Collateral amount mismatch");
        
        // 3. Borrow WETH against USDC collateral
        // Price approx: 1 ETH = 3000 USDC. 
        // 1000 USDC collateral allows borrowing roughly < 800 USDC worth of ETH (LTV dependent).
        // Let's borrow 0.1 ETH (~$300)
        uint256 borrowAmount = 0.1 ether; 
        
        CollateralManager.BorrowParams memory borrowParams = CollateralManager.BorrowParams({
            collateralAsset: USDC,
            collateralPct1e5: 500_000,
            debtAsset: WETH,
            amount: borrowAmount,
            interestRateMode: 2, // Variable
            referralCode: 0,
            recipient: user
        });
        
        manager.borrowLiquidity(borrowParams);
        
        assertEq(IERC20Like(WETH).balanceOf(user), borrowAmount, "User did not receive borrowed ETH");
        
        // 4. Repay Debt
        IERC20Like(WETH).approve(address(manager), borrowAmount);
        
        CollateralManager.RepayParams memory repayParams = CollateralManager.RepayParams({
            collateralAsset: USDC,
            collateralPct1e5: 500_000,
            debtAsset: WETH,
            amount: borrowAmount,
            interestRateMode: 2
        });
        
        manager.repayDebt(repayParams);
        
        uint256 remainingDebt = manager.getManagedDebt(user, USDC, 500_000, WETH, 2);
        assertEq(remainingDebt, 0, "Debt not fully cleared");
        
        vm.stopPrank();
    }
}

