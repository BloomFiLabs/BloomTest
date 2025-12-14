// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/LeveragedStrategyLite.sol";
import "../src/BloomStrategyVault.sol";

contract DeployLeveragedLite is Script {
    address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address constant HYPERLEND_POOL = 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b;
    uint32 constant HYPE_PERP_ASSET_ID = 4;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address vault = vm.envOr("LEVERAGED_VAULT_ADDRESS", address(0));
        
        console.log("Deployer:", deployer);
        
        vm.startBroadcast(pk);
        
        // Deploy vault if not provided
        if (vault == address(0)) {
            BloomStrategyVault v = new BloomStrategyVault(IERC20(USDC), address(0));
            vault = address(v);
            console.log("Vault:", vault);
        }
        
        // Deploy strategy
        LeveragedStrategyLite strategy = new LeveragedStrategyLite(
            vault,
            USDC,
            HYPERLEND_POOL,
            HYPE_PERP_ASSET_ID
        );
        console.log("Strategy:", address(strategy));
        
        // Register & setup
        BloomStrategyVault(vault).registerStrategy(address(strategy));
        strategy.setKeeper(deployer, true);
        strategy.setLeverageParams(20000, 30000);
        
        vm.stopBroadcast();
        
        console.log("");
        console.log("=== DEPLOYED ===");
        console.log("Vault:", vault);
        console.log("Strategy:", address(strategy));
    }
}


