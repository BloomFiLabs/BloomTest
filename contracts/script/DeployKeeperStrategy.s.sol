// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/BloomStrategyVault.sol";
import "../src/KeeperStrategyManager.sol";

/**
 * @title DeployKeeperStrategy
 * @notice Deploy KeeperStrategyManager and BloomStrategyVault on Arbitrum
 * 
 * Usage:
 *   # Load env vars
 *   source .env
 * 
 *   # Deploy to Arbitrum
 *   forge script script/DeployKeeperStrategy.s.sol:DeployKeeperStrategy \
 *     --rpc-url $ARBITRUM_RPC_URL \
 *     --private-key $PRIVATE_KEY \
 *     --broadcast \
 *     --verify \
 *     --etherscan-api-key $ARBISCAN_API_KEY
 * 
 *   # Or dry run first (no --broadcast)
 *   forge script script/DeployKeeperStrategy.s.sol:DeployKeeperStrategy \
 *     --rpc-url $ARBITRUM_RPC_URL \
 *     --private-key $PRIVATE_KEY
 */
contract DeployKeeperStrategy is Script {
    // Arbitrum USDC addresses
    address constant USDC_NATIVE = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // Native USDC
    address constant USDC_BRIDGED = 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8; // USDC.e (bridged)
    
    // Use native USDC by default
    address constant USDC = USDC_NATIVE;

    function run() external {
        // Deployer address will be set via --private-key flag
        // Keeper address - defaults to tx.origin if not set in env
        address keeper = vm.envOr("KEEPER_ADDRESS", tx.origin);
        
        console.log("=== Deploying KeeperStrategyManager to Arbitrum ===");
        console.log("Deployer: (from --private-key)");
        console.log("Keeper:", keeper);
        console.log("USDC:", USDC);
        console.log("");

        vm.startBroadcast();

        // 1. Deploy BloomStrategyVault (without initial strategy)
        BloomStrategyVault vault = new BloomStrategyVault(
            IERC20(USDC),
            address(0) // No initial strategy
        );
        console.log("BloomStrategyVault deployed at:", address(vault));

        // 2. Deploy KeeperStrategyManager
        KeeperStrategyManager strategy = new KeeperStrategyManager(
            address(vault),
            USDC,
            keeper
        );
        console.log("KeeperStrategyManager deployed at:", address(strategy));

        // 3. Register strategy with vault
        vault.registerStrategy(address(strategy));
        console.log("Strategy registered with vault");

        vm.stopBroadcast();

        // Output summary
        console.log("");
        console.log("=== Deployment Complete ===");
        console.log("Vault:", address(vault));
        console.log("Strategy:", address(strategy));
        console.log("Keeper:", keeper);
        console.log("");
        console.log("Next steps:");
        console.log("1. Update server/.env with:");
        console.log("   KEEPER_STRATEGY_ADDRESS=", address(strategy));
        console.log("   BLOOM_VAULT_ADDRESS=", address(vault));
        console.log("2. Users can now deposit USDC to the vault");
        console.log("3. Keeper bot will receive CapitalDeployed events");
    }
}

/**
 * @title DeployKeeperStrategyOnly
 * @notice Deploy only KeeperStrategyManager to an existing vault
 */
contract DeployKeeperStrategyOnly is Script {
    address constant USDC_NATIVE = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address keeper = vm.envOr("KEEPER_ADDRESS", deployer);
        address vaultAddress = vm.envAddress("VAULT_ADDRESS");

        console.log("=== Deploying KeeperStrategyManager Only ===");
        console.log("Existing Vault:", vaultAddress);
        console.log("Keeper:", keeper);

        vm.startBroadcast(deployerPrivateKey);

        KeeperStrategyManager strategy = new KeeperStrategyManager(
            vaultAddress,
            USDC_NATIVE,
            keeper
        );
        console.log("KeeperStrategyManager deployed at:", address(strategy));

        // Register with vault (caller must be vault owner)
        BloomStrategyVault vault = BloomStrategyVault(vaultAddress);
        vault.registerStrategy(address(strategy));
        console.log("Strategy registered with vault");

        vm.stopBroadcast();
    }
}

