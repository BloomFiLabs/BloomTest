// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DeltaNeutralFundingStrategy.sol";

/**
 * @title DeployHyperEVM
 * @notice Deploys the DeltaNeutralFundingStrategy to HyperEVM
 * 
 * Required environment variables:
 *   PRIVATE_KEY - Deployer private key
 *   KEEPER_ADDRESS - (Optional) Address to authorize as keeper
 * 
 * Usage:
 *   forge script script/DeployHyperEVM.s.sol:DeployHyperEVM --rpc-url https://rpc.hyperliquid.xyz/evm --broadcast
 */
contract DeployHyperEVM is Script {
    // HyperEVM Mainnet Addresses
    address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address constant UETH = 0xBe6727B535545C67d5cAa73dEa54865B92CF7907;  // UETH for HyperLend borrowing
    address constant HYPERLEND_POOL = 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b;
    
    // HyperLiquid Asset IDs
    uint32 constant ETH_ASSET_ID = 4; // ETH perp asset ID on HyperLiquid
    
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        // Optional: Get keeper address from env
        address keeperAddress = vm.envOr("KEEPER_ADDRESS", address(0));
        
        console.log("=== HyperEVM Deployment ===");
        console.log("Deployer:", deployer);
        console.log("USDC:", USDC);
        console.log("UETH:", UETH);
        console.log("HyperLend Pool:", HYPERLEND_POOL);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        // Deploy DeltaNeutralFundingStrategy
        // Note: We use deployer as vault for now (can be changed later)
        // In production, deploy a proper vault first
        console.log("Deploying DeltaNeutralFundingStrategy...");
        
        DeltaNeutralFundingStrategy strategy = new DeltaNeutralFundingStrategy(
            deployer,       // vault (using deployer for now, can transfer ownership)
            USDC,
            UETH,
            HYPERLEND_POOL,
            ETH_ASSET_ID
        );
        
        console.log("Strategy deployed at:", address(strategy));

        // Set up Keeper Role
        if (keeperAddress != address(0)) {
            console.log("Setting up keeper:", keeperAddress);
            strategy.setKeeper(keeperAddress, true);
            console.log("Keeper authorized");
        } else {
            // Authorize deployer as keeper by default
            console.log("No KEEPER_ADDRESS set, authorizing deployer as keeper");
            strategy.setKeeper(deployer, true);
        }

        vm.stopBroadcast();

        // Summary
        console.log("");
        console.log("=== Deployment Complete ===");
        console.log("DeltaNeutralFundingStrategy:", address(strategy));
        console.log("Owner:", strategy.owner());
        console.log("Vault:", deployer);
        console.log("");
        
        // Output JSON for config
        string memory json = "deployment";
        vm.serializeAddress(json, "DeltaNeutralFundingStrategy", address(strategy));
        vm.serializeAddress(json, "USDC", USDC);
        vm.serializeAddress(json, "UETH", UETH);
        vm.serializeAddress(json, "HyperLendPool", HYPERLEND_POOL);
        vm.serializeUint(json, "chainId", 999);
        string memory finalJson = vm.serializeAddress(json, "deployer", deployer);
        
        console.log("=== Config JSON ===");
        console.log(finalJson);
        console.log("===================");
        console.log("");
        console.log("Copy the JSON above to update your config files!");
    }
}

/**
 * @title DeployHyperEVMWithVault
 * @notice Deploys both BloomStrategyVault and DeltaNeutralFundingStrategy to HyperEVM
 */
contract DeployHyperEVMWithVault is Script {
    // HyperEVM Mainnet Addresses
    address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address constant WETH = 0xADcb2f358Eae6492F61A5F87eb8893d09391d160;
    address constant HYPERLEND_POOL = 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b;
    uint32 constant ETH_ASSET_ID = 4;
    
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address keeperAddress = vm.envOr("KEEPER_ADDRESS", deployer);
        
        console.log("=== HyperEVM Full Deployment ===");
        console.log("Deployer:", deployer);
        
        vm.startBroadcast(deployerPrivateKey);
        
        // 1. Deploy Vault (using simple interface for now)
        // Note: BloomStrategyVault needs IERC20, so we import it
        console.log("1. Deploying BloomStrategyVault...");
        BloomStrategyVault vault = new BloomStrategyVault(IERC20(USDC), address(0));
        console.log("   Vault:", address(vault));
        
        // 2. Deploy Strategy
        console.log("2. Deploying DeltaNeutralFundingStrategy...");
        DeltaNeutralFundingStrategy strategy = new DeltaNeutralFundingStrategy(
            address(vault),
            USDC,
            WETH,
            HYPERLEND_POOL,
            ETH_ASSET_ID
        );
        console.log("   Strategy:", address(strategy));
        
        // 3. Register strategy with vault
        console.log("3. Registering strategy with vault...");
        vault.registerStrategy(address(strategy));
        
        // 4. Set keeper
        console.log("4. Setting keeper:", keeperAddress);
        strategy.setKeeper(keeperAddress, true);
        
        vm.stopBroadcast();
        
        // Summary
        console.log("");
        console.log("=== Deployment Complete ===");
        console.log("BloomStrategyVault:", address(vault));
        console.log("DeltaNeutralFundingStrategy:", address(strategy));
        console.log("Keeper:", keeperAddress);
        console.log("");
        
        // Output JSON
        string memory json = "deployment";
        vm.serializeAddress(json, "BloomStrategyVault", address(vault));
        vm.serializeAddress(json, "DeltaNeutralFundingStrategy", address(strategy));
        vm.serializeAddress(json, "USDC", USDC);
        vm.serializeAddress(json, "WETH", WETH);
        vm.serializeAddress(json, "HyperLendPool", HYPERLEND_POOL);
        vm.serializeUint(json, "chainId", 999);
        string memory finalJson = vm.serializeAddress(json, "deployer", deployer);
        
        console.log("=== Config JSON ===");
        console.log(finalJson);
        
        vm.writeJson(finalJson, "./deployments/hyperevm-full-latest.json");
    }
}

// Import for vault deployment
import "../src/BloomStrategyVault.sol";
