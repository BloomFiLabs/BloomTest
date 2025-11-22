// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/BloomStrategyVault.sol";
import "../src/DeltaNeutralStrategy.sol";
import "../src/LiquidityRangeManager.sol";
import "../src/CollateralManager.sol";

contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        // Base Mainnet Addresses
        address usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        address weth = 0x4200000000000000000000000000000000000006;
        address pool = 0xd0b53D9277642d899DF5C87A3966A349A798F224; // WETH/USDC 0.05%
        address nfpm = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
        address pap = 0xE20fCBDbf6702785b921b7a09723Dc382596d64D;
        address router = 0x2626664c2603336E57B271c5C0b26F421741e481;

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy Managers
        LiquidityRangeManager lrm = new LiquidityRangeManager(nfpm);
        CollateralManager cm = new CollateralManager(pap);
        
        // 2. Deploy Vault
        BloomStrategyVault vault = new BloomStrategyVault(IERC20(usdc), address(0));
        
        // 3. Deploy Strategy
        DeltaNeutralStrategy strategy = new DeltaNeutralStrategy(
            address(vault),
            address(lrm),
            address(cm),
            router,
            pool,
            usdc,
            weth
        );
        
        // 4. Register Strategy
        vault.registerStrategy(address(strategy));
        
        vm.stopBroadcast();
        
        console.log("LiquidityRangeManager:", address(lrm));
        console.log("CollateralManager:", address(cm));
        console.log("BloomStrategyVault:", address(vault));
        console.log("DeltaNeutralStrategy:", address(strategy));
    }
}


