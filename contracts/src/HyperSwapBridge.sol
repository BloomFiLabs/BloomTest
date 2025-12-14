// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title HyperSwap Bridge
 * @notice Bridges USDC from HyperEVM to HyperCore via HYPE
 * 
 * Flow:
 * 1. Swap USDC → WHYPE on HyperSwap V3
 * 2. Unwrap WHYPE → native HYPE
 * 3. Send native HYPE to 0x2222...2222 (bridges to HyperCore)
 */

/// @notice HyperSwap V3 SwapRouter interface
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice WHYPE interface
interface IWHYPE {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract HyperSwapBridge is Ownable {
    using SafeERC20 for IERC20;

    // HyperSwap V3 contracts
    address public constant HYPERSWAP_V3_ROUTER = 0x6D99e7f6747AF2cDbB5164b6DD50e40D4fDe1e77;
    address public constant WHYPE = 0x5555555555555555555555555555555555555555;
    address public constant HYPE_SYSTEM_ADDRESS = 0x2222222222222222222222222222222222222222;

    IERC20 public immutable usdc;
    mapping(address => bool) public keepers;

    event SwappedUSDCToHYPE(uint256 usdcIn, uint256 hypeOut);
    event HYPEBridgedToCore(uint256 amount);
    event KeeperUpdated(address indexed keeper, bool active);

    modifier onlyKeeper() {
        require(keepers[msg.sender] || msg.sender == owner(), "Only Keeper");
        _;
    }

    constructor(address _usdc) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
    }

    function setKeeper(address keeper, bool active) external onlyOwner {
        keepers[keeper] = active;
        emit KeeperUpdated(keeper, active);
    }

    /// @notice Deposit USDC to the bridge contract
    function deposit(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Swap USDC to native HYPE and bridge to HyperCore
    function swapAndBridgeToCore(
        uint256 usdcAmount,
        uint256 minHypeOut,
        uint24 poolFee
    ) external onlyKeeper {
        require(usdcAmount > 0, "Amount must be > 0");
        
        // Step 1: Swap USDC → WHYPE
        usdc.approve(HYPERSWAP_V3_ROUTER, usdcAmount);
        
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: address(usdc),
            tokenOut: WHYPE,
            fee: poolFee,
            recipient: address(this),
            amountIn: usdcAmount,
            amountOutMinimum: minHypeOut,
            sqrtPriceLimitX96: 0
        });
        
        uint256 whypeReceived = ISwapRouter(HYPERSWAP_V3_ROUTER).exactInputSingle(params);
        emit SwappedUSDCToHYPE(usdcAmount, whypeReceived);
        
        // Step 2: Unwrap WHYPE → native HYPE
        IWHYPE(WHYPE).withdraw(whypeReceived);
        
        // Step 3: Bridge native HYPE to HyperCore
        (bool success, ) = HYPE_SYSTEM_ADDRESS.call{value: whypeReceived}("");
        require(success, "HYPE bridge failed");
        
        emit HYPEBridgedToCore(whypeReceived);
    }

    /// @notice Get USDC balance
    function getUSDCBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Get native HYPE balance
    function getHYPEBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Rescue stuck tokens
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }

    /// @notice Rescue stuck HYPE
    function rescueHYPE() external onlyOwner {
        (bool success, ) = owner().call{value: address(this).balance}("");
        require(success, "HYPE rescue failed");
    }

    receive() external payable {}
}

