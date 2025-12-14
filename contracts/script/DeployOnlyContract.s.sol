// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/LeveragedStrategyLite.sol";

contract DeployOnlyContract is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        new LeveragedStrategyLite(
            0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03,
            0xb88339CB7199b77E23DB6E890353E22632Ba630f,
            0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b,
            4
        );
        vm.stopBroadcast();
    }
}


