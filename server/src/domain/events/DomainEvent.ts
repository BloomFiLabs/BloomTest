/**
 * Domain event interface
 * Represents a significant occurrence in the domain
 */
export interface DomainEvent {
  eventId: string;
  occurredOn: Date;
  eventType: string;
}

/**
 * Base domain event class
 * Provides common functionality for all domain events
 */
export abstract class BaseDomainEvent implements DomainEvent {
  public readonly eventId: string;
  public readonly occurredOn: Date;
  public abstract readonly eventType: string;

  constructor(eventType: string) {
    this.eventId = `${eventType}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.occurredOn = new Date();
  }
}

/**
 * Event bus interface for publishing domain events
 */
export interface IEventBus {
  /**
   * Publish a domain event
   * @param event The domain event to publish
   */
  publish(event: DomainEvent): Promise<void>;

  /**
   * Subscribe to domain events of a specific type
   * @param eventType The type of event to subscribe to
   * @param handler The handler function to call when the event is published
   */
  subscribe<T extends DomainEvent>(
    eventType: string,
    handler: (event: T) => Promise<void> | void,
  ): void;

  /**
   * Unsubscribe from domain events of a specific type
   * @param eventType The type of event to unsubscribe from
   * @param handler The handler function to remove
   */
  unsubscribe<T extends DomainEvent>(
    eventType: string,
    handler: (event: T) => Promise<void> | void,
  ): void;
}
