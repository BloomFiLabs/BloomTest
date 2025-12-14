// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/LeveragedStrategyLite.sol";

contract DeployDirectStrategy is Script {
    address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address constant HYPERLEND_POOL = 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b;
    uint32 constant HYPE_PERP_ASSET_ID = 4;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        
        console.log("Deployer:", deployer);
        
        vm.startBroadcast(pk);
        
        // Pass deployer as vault address to allow owner to withdraw if needed
        LeveragedStrategyLite strategy = new LeveragedStrategyLite(
            deployer, // "Vault" is deployer for direct access
            USDC,
            HYPERLEND_POOL,
            HYPE_PERP_ASSET_ID
        );
        
        strategy.setKeeper(deployer, true);
        strategy.setLeverageParams(20000, 30000);
        
        vm.stopBroadcast();
        
        console.log("Strategy Deployed:", address(strategy));
    }
}


