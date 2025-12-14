// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ILighterPerps
 * @notice Interface for Lighter Protocol Perpetual Futures
 * @dev Based on Lighter's perpetual futures contract structure
 * 
 * Note: Update function signatures based on Lighter's actual ABI
 * Documentation: https://docs.lighter.xyz/
 */

interface ILighterPerps {
    /**
     * @notice Place a perpetual futures order
     * @param marketId The market ID (e.g., ETH/USDC)
     * @param size Order size (in base asset units, e.g., 1e18 for 1 ETH)
     * @param price Limit price (in quote asset units, e.g., 1e6 for $1 USDC)
     * @param isBuy true for long/buy, false for short/sell
     * @param leverage Leverage multiplier (e.g., 10 for 10x)
     * @return orderId The order ID
     */
    function placeOrder(
        uint256 marketId,
        uint256 size,
        uint256 price,
        bool isBuy,
        uint256 leverage
    ) external returns (uint256 orderId);

    /**
     * @notice Cancel an existing order
     * @param orderId The order ID to cancel
     */
    function cancelOrder(uint256 orderId) external;

    /**
     * @notice Get order details
     * @param orderId The order ID
     * @return marketId Market ID
     * @return size Order size
     * @return price Order price
     * @return isBuy Order side
     * @return leverage Leverage
     * @return filled Amount filled
     * @return status Order status (0 = pending, 1 = filled, 2 = cancelled)
     */
    function getOrder(uint256 orderId) external view returns (
        uint256 marketId,
        uint256 size,
        uint256 price,
        bool isBuy,
        uint256 leverage,
        uint256 filled,
        uint8 status
    );

    /**
     * @notice Get user's position for a market
     * @param user User address
     * @param marketId Market ID
     * @return size Position size (positive = long, negative = short)
     * @return entryPrice Average entry price
     * @return margin Margin used
     * @return unrealizedPnl Unrealized PnL
     */
    function getPosition(
        address user,
        uint256 marketId
    ) external view returns (
        int256 size,
        uint256 entryPrice,
        uint256 margin,
        int256 unrealizedPnl
    );

    /**
     * @notice Close a position (market order)
     * @param marketId Market ID
     * @param size Size to close (absolute value)
     * @param isBuy true to close long, false to close short
     */
    function closePosition(
        uint256 marketId,
        uint256 size,
        bool isBuy
    ) external;
}

/**
 * @title ILighterGateway
 * @notice Interface for Lighter Gateway contract (Ethereum Gateway)
 * @dev The gateway contract handles deposits, withdrawals, and order routing
 */
interface ILighterGateway {
    /**
     * @notice Deposit collateral to the gateway
     * @param token Token address (e.g., USDC)
     * @param amount Amount to deposit
     */
    function deposit(address token, uint256 amount) external;

    /**
     * @notice Withdraw collateral from the gateway
     * @param token Token address
     * @param amount Amount to withdraw
     */
    function withdraw(address token, uint256 amount) external;

    /**
     * @notice Get user's balance for a token
     * @param user User address
     * @param token Token address
     * @return balance User's balance
     */
    function getBalance(address user, address token) external view returns (uint256 balance);
}

