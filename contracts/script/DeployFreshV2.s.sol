// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/BloomStrategyVault.sol";
import "../src/LeveragedStrategyLite.sol";

contract DeployFreshV2 is Script {
    address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address constant HYPERLEND_POOL = 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b;
    uint32 constant HYPE_PERP_ASSET_ID = 4;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        
        console.log("Deployer:", deployer);
        
        vm.startBroadcast(pk);
        
        // 1. Deploy vault
        BloomStrategyVault vault = new BloomStrategyVault(
            IERC20(USDC),
            address(0)
        );
        console.log("Vault:", address(vault));
        
        vm.stopBroadcast();
    }
}


