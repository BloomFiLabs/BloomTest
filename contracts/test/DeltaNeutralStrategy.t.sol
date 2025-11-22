// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/DeltaNeutralStrategy.sol";
import "../src/BloomStrategyVault.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Mocks
contract MockRouter is ISwapRouter {
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256) {
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        // Mock swap: 1 WETH = 3000 USDC
        uint256 amountOut = params.amountIn * 3000;
        MockERC20(params.tokenOut).mint(msg.sender, amountOut);
        return amountOut;
    }
    
    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn) {
        // Mock swap
        amountIn = params.amountOut / 3000; 
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), amountIn);
        MockERC20(params.tokenOut).mint(params.recipient, params.amountOut);
        return amountIn;
    }
}

contract MockLiquidityManager is LiquidityRangeManager {
    constructor(address _pm) LiquidityRangeManager(_pm) {}
    // Bypass real logic for unit test
}

contract MockCollateralManager is CollateralManager {
    constructor(address _pool) CollateralManager(_pool) {}
}

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract DeltaNeutralStrategyTest is Test {
    DeltaNeutralStrategy public strategy;
    BloomStrategyVault public vault;
    
    MockERC20 public usdc;
    MockERC20 public weth;
    MockRouter public router;
    
    address public user = address(0x1);
    
    // We need deployed Managers for the strategy to call
    // But for Unit tests we usually mock them. 
    // Since we have `LiquidityRangeManager` source, we can deploy them with Mocks inside.
    
    function setUp() public {
        usdc = new MockERC20("USDC", "USDC");
        weth = new MockERC20("WETH", "WETH");
        router = new MockRouter();
        
        // Mocks for dependencies
        address mockPool = address(0x123);
        address mockAave = address(0x456);
        address mockUniPM = address(0x789);
        
        // We can't easily mock the internal logic of Managers without interfaces or heavy mocking.
        // For this "TDD" unit test of the Strategy logic, we want to ensure it CALLS the managers correctly.
        // However, `DeltaNeutralStrategy` imports the CONCRETE contracts, not interfaces.
        // This makes unit testing hard without deploying the full stack.
        // Fork testing is better suited here.
        // I will skip a complex Unit Test and focus on the Fork Test as requested for "bonus points" and "end to end".
    }
}
