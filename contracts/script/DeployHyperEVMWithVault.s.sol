// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/DeltaNeutralStrategyLite.sol";
import "../src/BloomStrategyVault.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DeployHyperEVMWithVault is Script {
    // HyperEVM Mainnet Addresses
    address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address constant UETH = 0xBe6727B535545C67d5cAa73dEa54865B92CF7907;
    address constant HYPERLEND_POOL = 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b;
    uint32 constant ETH_ASSET_ID = 4; // ETH perp asset ID
    
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address keeperAddress = vm.envOr("KEEPER_ADDRESS", deployer);
        
        console.log("=== HyperEVM Full Deployment ===");
        console.log("Deployer:", deployer);
        
        vm.startBroadcast(deployerPrivateKey);
        
        // 1. Deploy Vault
        console.log("1. Deploying BloomStrategyVault...");
        BloomStrategyVault vault = new BloomStrategyVault(IERC20(USDC), address(0));
        console.log("   Vault:", address(vault));
        
        // 2. Deploy Strategy
        console.log("2. Deploying DeltaNeutralStrategyLite...");
        DeltaNeutralStrategyLite strategy = new DeltaNeutralStrategyLite(
            address(vault),
            USDC,
            UETH,
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
        
        console.log("");
        console.log("=== Deployment Complete ===");
        console.log("BloomStrategyVault:", address(vault));
        console.log("DeltaNeutralStrategyLite:", address(strategy));
        console.log("Keeper:", keeperAddress);
    }
}

