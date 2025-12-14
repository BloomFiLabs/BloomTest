// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

interface IStrategy {
    function totalAssets() external view returns (uint256);
    function totalPrincipal() external view returns (uint256);
    function getIdleUSDC() external view returns (uint256);
    function getWethBalance() external view returns (uint256);
    function getPerpEquity() external view returns (uint256);
    function getHyperLendData() external view returns (
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 availableBorrows,
        uint256 liquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    );
    function emergencyWithdrawAll() external;
    function closeAllPerpPositions() external;
    function withdrawCollateral(uint256 amount) external;
    function repay(address asset, uint256 amount) external;
    function rescueTokens(address token, uint256 amount) external;
    function owner() external view returns (address);
    function keepers(address) external view returns (bool);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function symbol() external view returns (string memory);
}

contract WithdrawFromStrategy is Script {
    // Deployed addresses from config
    address constant STRATEGY = 0x2b0Cddac29cCd8529aB849B8DC9a826f67D55919;
    address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address constant WETH = 0xADcb2f358Eae6492F61A5F87eb8893d09391d160;
    
    function run() external {
        // First, just read the state
        console.log("=== Strategy State ===");
        console.log("Strategy Address:", STRATEGY);
        
        IStrategy strategy = IStrategy(STRATEGY);
        
        // Check ownership
        address owner = strategy.owner();
        console.log("Owner:", owner);
        console.log("Caller:", msg.sender);
        
        // Check balances
        uint256 totalAssets;
        uint256 totalPrincipal;
        uint256 idleUSDC;
        uint256 wethBalance;
        
        try strategy.totalAssets() returns (uint256 val) {
            totalAssets = val;
            console.log("Total Assets:", totalAssets / 1e6, "USDC");
        } catch {
            console.log("totalAssets() failed");
        }
        
        try strategy.totalPrincipal() returns (uint256 val) {
            totalPrincipal = val;
            console.log("Total Principal:", totalPrincipal / 1e6, "USDC");
        } catch {
            console.log("totalPrincipal() failed");
        }
        
        try strategy.getIdleUSDC() returns (uint256 val) {
            idleUSDC = val;
            console.log("Idle USDC:", idleUSDC / 1e6, "USDC");
        } catch {
            console.log("getIdleUSDC() failed");
        }
        
        try strategy.getWethBalance() returns (uint256 val) {
            wethBalance = val;
            console.log("WETH Balance:", wethBalance / 1e18, "WETH");
        } catch {
            console.log("getWethBalance() failed");
        }
        
        // Check HyperLend position
        try strategy.getHyperLendData() returns (
            uint256 totalCollateral,
            uint256 totalDebt,
            uint256 availableBorrows,
            uint256 liquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        ) {
            console.log("\n=== HyperLend Position ===");
            console.log("Collateral:", totalCollateral / 1e6, "USD");
            console.log("Debt:", totalDebt / 1e18, "ETH");
            console.log("Health Factor:", healthFactor / 1e18);
        } catch {
            console.log("No HyperLend position or call failed");
        }
        
        // Check perp position
        try strategy.getPerpEquity() returns (uint256 val) {
            console.log("\n=== Perp Position ===");
            console.log("Perp Equity:", val / 1e6, "USD");
        } catch {
            console.log("No perp position or call failed");
        }
        
        // Check raw ERC20 balances
        console.log("\n=== Raw Token Balances ===");
        uint256 usdcBal = IERC20(USDC).balanceOf(STRATEGY);
        console.log("USDC in contract:", usdcBal / 1e6);
        
        if (WETH != address(0)) {
            uint256 wethBal = IERC20(WETH).balanceOf(STRATEGY);
            console.log("WETH in contract:", wethBal / 1e18);
        }
        
        console.log("\n=== Actions Available ===");
        if (usdcBal > 0 || wethBalance > 0) {
            console.log("Assets found! Run with --broadcast to withdraw");
        } else {
            console.log("No assets to withdraw");
        }
    }
    
    function withdraw() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);
        
        IStrategy strategy = IStrategy(STRATEGY);
        
        console.log("=== Withdrawing All Assets ===");
        console.log("Owner:", strategy.owner());
        
        // 1. Withdraw collateral from HyperLend (no debt, so we can withdraw all)
        console.log("1. Withdrawing collateral from HyperLend...");
        // Use max uint256 to withdraw everything
        try strategy.withdrawCollateral(type(uint256).max) {
            console.log("   Collateral withdrawn");
        } catch {
            console.log("   withdrawCollateral failed, trying emergencyWithdrawAll...");
            try strategy.emergencyWithdrawAll() {
                console.log("   Emergency withdraw complete");
            } catch {
                console.log("   Emergency withdraw also failed");
            }
        }
        
        // 2. Check and rescue any USDC in contract
        uint256 usdcBal = IERC20(USDC).balanceOf(STRATEGY);
        console.log("2. USDC in contract after withdraw:", usdcBal / 1e6);
        
        if (usdcBal > 0) {
            console.log("   Rescuing USDC to owner...");
            try strategy.rescueTokens(USDC, usdcBal) {
                console.log("   USDC rescued successfully!");
            } catch {
                console.log("   USDC rescue failed");
            }
        }
        
        vm.stopBroadcast();
        
        // Final check
        uint256 finalBal = IERC20(USDC).balanceOf(STRATEGY);
        console.log("\n=== Withdrawal Complete ===");
        console.log("Remaining USDC in strategy:", finalBal / 1e6);
        console.log("Check your wallet for rescued tokens");
    }
}

