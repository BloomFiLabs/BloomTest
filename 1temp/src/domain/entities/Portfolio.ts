import { Position } from './Position';
import { Amount } from '../value-objects/Amount';
import { PnL } from '../value-objects/PnL';

export interface PortfolioProps {
  id: string;
  initialCapital: Amount;
}

export class Portfolio {
  private _id: string;
  private _initialCapital: Amount;
  private _positions: Position[];
  private _cash: Amount;

  private constructor(props: PortfolioProps) {
    this._id = props.id;
    this._initialCapital = props.initialCapital;
    this._positions = [];
    this._cash = props.initialCapital;
  }

  static create(props: PortfolioProps): Portfolio {
    return new Portfolio(props);
  }

  get id(): string {
    return this._id;
  }

  get initialCapital(): Amount {
    return this._initialCapital;
  }

  get positions(): Position[] {
    return [...this._positions];
  }

  set positions(positions: Position[]) {
    this._positions = [...positions];
  }

  get cash(): Amount {
    return this._cash;
  }

  addPosition(position: Position, cost?: Amount): void {
    this._positions.push(position);
    if (cost) {
      this._cash = this._cash.subtract(cost);
    }
  }

  removePosition(positionId: string): void {
    this._positions = this._positions.filter(p => p.id !== positionId);
  }

  updatePosition(position: Position): void {
    const index = this._positions.findIndex(p => p.id === position.id);
    if (index !== -1) {
      this._positions[index] = position;
    }
  }

  totalValue(): Amount {
    const positionsValue = this._positions.reduce(
      (sum, position) => sum.add(position.marketValue()),
      Amount.zero()
    );
    return this._cash.add(positionsValue);
  }

  totalPnL(): PnL {
    const currentValue = this.totalValue();
    return PnL.create(currentValue.subtract(this._initialCapital).value);
  }

  findPosition(strategyId: string, asset: string): Position | undefined {
    return this._positions.find(
      p => p.strategyId === strategyId && p.asset === asset
    );
  }

  // Implement getPosition to satisfy Strategy interface
  getPosition(positionId: string): Position | undefined {
    return this._positions.find(p => p.id === positionId);
  }
}

