// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/LeveragedStrategyLite.sol";

contract DeployStrategyMin is Script {
    address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address constant HYPERLEND_POOL = 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b;
    uint32 constant HYPE_PERP_ASSET_ID = 4;
    address constant EXISTING_VAULT = 0x658aF928F56391bFdbf3A7d16D5016db08f791d0;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        new LeveragedStrategyLite(EXISTING_VAULT, USDC, HYPERLEND_POOL, HYPE_PERP_ASSET_ID);
        vm.stopBroadcast();
    }
}


