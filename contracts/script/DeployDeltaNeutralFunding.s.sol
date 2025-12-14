// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/DeltaNeutralFundingStrategy.sol";
import "../src/BloomStrategyVault.sol";

/**
 * @title Deploy Delta-Neutral Funding Strategy
 * @notice Deploys the delta-neutral funding strategy that integrates HyperLend + HyperLiquid Perps
 * 
 * REQUIRED ENV VARS:
 * - PRIVATE_KEY: Deployer private key
 * - HYPERLEND_POOL_ADDRESS: HyperLend lending pool contract
 * - WETH_ADDRESS: WETH on HyperEVM
 * - USDC_ADDRESS: USDC on HyperEVM (default: 0xb88339CB7199b77E23DB6E890353E22632Ba630f)
 * - VAULT_ADDRESS: Existing BloomStrategyVault (optional, will deploy new if not set)
 * - KEEPER_ADDRESS: Address to authorize as keeper
 */
contract DeployDeltaNeutralFunding is Script {
    // Known HyperEVM addresses
    address constant USDC_HYPEREVM = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    
    // HyperLiquid Asset IDs
    uint32 constant ETH_ASSET_ID = 4;  // ETH on HyperLiquid
    
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        // Get addresses from env (with defaults where possible)
        address hyperLendPool = vm.envOr("HYPERLEND_POOL_ADDRESS", address(0));
        address wethAddress = vm.envOr("WETH_ADDRESS", address(0));
        address usdcAddress = vm.envOr("USDC_ADDRESS", USDC_HYPEREVM);
        address vaultAddress = vm.envOr("VAULT_ADDRESS", address(0));
        address keeperAddress = vm.envOr("KEEPER_ADDRESS", deployer);
        
        console.log("=== DELTA-NEUTRAL FUNDING STRATEGY DEPLOYMENT ===");
        console.log("Deployer:", deployer);
        console.log("USDC:", usdcAddress);
        console.log("WETH:", wethAddress);
        console.log("HyperLend Pool:", hyperLendPool);
        console.log("Keeper:", keeperAddress);
        console.log("");
        
        // Validate required addresses
        if (hyperLendPool == address(0)) {
            console.log("ERROR: HYPERLEND_POOL_ADDRESS not set!");
            console.log("");
            console.log("Please get the HyperLend pool address from:");
            console.log("  https://app.hyperlend.finance/dashboard");
            console.log("  or https://docs.hyperlend.finance/");
            console.log("");
            console.log("Then set it in .env:");
            console.log("  HYPERLEND_POOL_ADDRESS=0x...");
            revert("Missing HYPERLEND_POOL_ADDRESS");
        }
        
        if (wethAddress == address(0)) {
            console.log("ERROR: WETH_ADDRESS not set!");
            console.log("");
            console.log("Please find the WETH address on HyperEVM");
            console.log("Then set it in .env:");
            console.log("  WETH_ADDRESS=0x...");
            revert("Missing WETH_ADDRESS");
        }

        vm.startBroadcast(deployerPrivateKey);

        // Deploy or use existing vault
        BloomStrategyVault vault;
        if (vaultAddress == address(0)) {
            console.log("Deploying new BloomStrategyVault...");
            vault = new BloomStrategyVault(IERC20(usdcAddress), address(0));
            console.log("Vault deployed at:", address(vault));
        } else {
            console.log("Using existing vault:", vaultAddress);
            vault = BloomStrategyVault(vaultAddress);
        }

        // Deploy Delta-Neutral Funding Strategy
        console.log("");
        console.log("Deploying DeltaNeutralFundingStrategy...");
        DeltaNeutralFundingStrategy strategy = new DeltaNeutralFundingStrategy(
            address(vault),
            usdcAddress,
            wethAddress,
            hyperLendPool,
            ETH_ASSET_ID
        );
        console.log("Strategy deployed at:", address(strategy));

        // Register strategy with vault
        console.log("");
        console.log("Registering strategy with vault...");
        vault.registerStrategy(address(strategy));
        console.log("Strategy registered!");

        // Set keeper
        console.log("");
        console.log("Setting keeper:", keeperAddress);
        strategy.setKeeper(keeperAddress, true);
        console.log("Keeper authorized!");

        vm.stopBroadcast();

        // Output summary
        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("");
        console.log("Addresses:");
        console.log("  Vault:", address(vault));
        console.log("  Strategy:", address(strategy));
        console.log("  Keeper:", keeperAddress);
        console.log("");
        console.log("Strategy Configuration:");
        console.log("  Asset: ETH (ID:", ETH_ASSET_ID, ")");
        console.log("  Max Leverage: 3x");
        console.log("  Min Health Factor: 1.5");
        console.log("  HyperLend Pool:", hyperLendPool);
        console.log("");
        console.log("Next Steps:");
        console.log("  1. Deposit USDC to vault: vault.deposit(amount)");
        console.log("  2. Allocate to strategy: vault.allocateToStrategy(strategy, amount)");
        console.log("  3. Open position: strategy.openDeltaNeutralPosition(ethPrice)");
        console.log("  4. Monitor health factor: strategy.checkHealthFactor()");
        console.log("");
        
        console.log("Save these addresses to deployed_delta_neutral.json manually");
    }
}

