// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/BloomStrategyVault.sol";

/// @title Deploy Vault (Step 1)
contract DeployLeveragedStep1 is Script {
    address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        console.log("Deploying BloomStrategyVault...");
        
        vm.startBroadcast(deployerPrivateKey);
        BloomStrategyVault vault = new BloomStrategyVault(
            IERC20(USDC),
            address(0)
        );
        vm.stopBroadcast();
        
        console.log("Vault deployed at:", address(vault));
    }
}


