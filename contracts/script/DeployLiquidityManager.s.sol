// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/LiquidityRangeManager.sol";

contract DeployLiquidityManager is Script {
    address constant NPM = 0x6eDA206207c09e5428F281761DdC0D300851fBC8;

    function run() external returns (LiquidityRangeManager manager) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        manager = new LiquidityRangeManager(NPM);
        vm.stopBroadcast();
    }
}
