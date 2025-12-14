// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

interface IStrategy {
    function deposit(uint256 amount) external;
    function totalAssets() external view returns (uint256);
    function totalPrincipal() external view returns (uint256);
    function getIdleUSDC() external view returns (uint256);
    function depositCollateral(uint256 amount) external;
    function owner() external view returns (address);
    function vault() external view returns (address);
}

contract DepositToStrategy is Script {
    address constant STRATEGY = 0xD5a0AAc6B35e76f5FA1CE0481b4d7F4a85947dbe;
    address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    
    function run() external view {
        console.log("=== Pre-Deposit Check ===");
        console.log("Strategy:", STRATEGY);
        console.log("");
        
        // Check wallet balance
        address deployer = 0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03;
        uint256 walletBalance = IERC20(USDC).balanceOf(deployer);
        console.log("Wallet USDC balance:", walletBalance / 1e6, "USDC");
        
        // Check strategy state
        IStrategy strategy = IStrategy(STRATEGY);
        console.log("Strategy vault:", strategy.vault());
        console.log("Strategy owner:", strategy.owner());
        
        uint256 strategyBalance = IERC20(USDC).balanceOf(STRATEGY);
        console.log("Strategy USDC balance:", strategyBalance / 1e6, "USDC");
        
        console.log("");
        console.log("To deposit, run: forge script script/DepositToStrategy.s.sol:DepositToStrategy --sig 'deposit(uint256)' <AMOUNT_IN_USDC> --rpc-url https://rpc.hyperliquid.xyz/evm --broadcast");
    }
    
    function deposit(uint256 amountUSDC) external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        uint256 amount = amountUSDC * 1e6; // Convert to 6 decimals
        
        console.log("=== Depositing to Strategy ===");
        console.log("Amount:", amountUSDC, "USDC");
        console.log("Deployer (vault):", deployer);
        
        // Check balance
        uint256 walletBalance = IERC20(USDC).balanceOf(deployer);
        console.log("Wallet balance:", walletBalance / 1e6, "USDC");
        require(walletBalance >= amount, "Insufficient USDC balance");
        
        vm.startBroadcast(deployerPrivateKey);
        
        IStrategy strategy = IStrategy(STRATEGY);
        
        // Since deployer == vault, we can call deposit() directly
        // deposit() uses safeTransferFrom, so we need to approve first
        
        // 1. Approve strategy to spend USDC
        console.log("1. Approving strategy to spend USDC...");
        IERC20(USDC).approve(STRATEGY, amount);
        
        // 2. Call deposit() - this transfers USDC to strategy and updates totalPrincipal
        console.log("2. Calling deposit()...");
        strategy.deposit(amount);
        
        // 3. Now move to HyperLend as collateral
        console.log("3. Depositing to HyperLend as collateral...");
        strategy.depositCollateral(amount);
        
        vm.stopBroadcast();
        
        // Verify
        console.log("");
        console.log("=== Deposit Complete ===");
        console.log("Total Principal:", strategy.totalPrincipal() / 1e6, "USDC");
    }
    
    function depositAll() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        uint256 walletBalance = IERC20(USDC).balanceOf(deployer);
        require(walletBalance > 0, "No USDC to deposit");
        
        console.log("=== Depositing ALL USDC to Strategy ===");
        console.log("Amount:", walletBalance / 1e6, "USDC");
        console.log("Deployer (vault):", deployer);
        
        vm.startBroadcast(deployerPrivateKey);
        
        IStrategy strategy = IStrategy(STRATEGY);
        
        // 1. Approve strategy to spend USDC
        console.log("1. Approving strategy to spend USDC...");
        IERC20(USDC).approve(STRATEGY, walletBalance);
        
        // 2. Call deposit() - this transfers USDC to strategy and updates totalPrincipal
        console.log("2. Calling deposit()...");
        strategy.deposit(walletBalance);
        
        // 3. Now move to HyperLend as collateral
        console.log("3. Depositing to HyperLend as collateral...");
        strategy.depositCollateral(walletBalance);
        
        vm.stopBroadcast();
        
        console.log("");
        console.log("=== Deposit Complete ===");
        console.log("Total Principal:", strategy.totalPrincipal() / 1e6, "USDC");
    }
}

