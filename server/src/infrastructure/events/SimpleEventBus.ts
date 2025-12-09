import { Injectable, Logger } from '@nestjs/common';
import { IEventBus, DomainEvent } from '../../domain/events/DomainEvent';

/**
 * Simple in-memory event bus implementation
 */
@Injectable()
export class SimpleEventBus implements IEventBus {
  private readonly logger = new Logger(SimpleEventBus.name);
  private readonly subscribers: Map<string, Array<(event: DomainEvent) => Promise<void> | void>> = new Map();

  async publish(event: DomainEvent): Promise<void> {
    const handlers = this.subscribers.get(event.eventType) || [];
    
    this.logger.debug(`Publishing event: ${event.eventType} (${event.eventId})`);
    
    // Execute all handlers
    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (error: any) {
        this.logger.error(`Error handling event ${event.eventType}: ${error.message}`, error.stack);
      }
    }
  }

  subscribe<T extends DomainEvent>(
    eventType: string,
    handler: (event: T) => Promise<void> | void,
  ): void {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, []);
    }
    
    const handlers = this.subscribers.get(eventType)!;
    handlers.push(handler as (event: DomainEvent) => Promise<void> | void);
    
    this.logger.debug(`Subscribed to event type: ${eventType}`);
  }

  unsubscribe<T extends DomainEvent>(
    eventType: string,
    handler: (event: T) => Promise<void> | void,
  ): void {
    const handlers = this.subscribers.get(eventType);
    if (!handlers) {
      return;
    }
    
    const index = handlers.findIndex((h) => h === handler);
    if (index !== -1) {
      handlers.splice(index, 1);
      this.logger.debug(`Unsubscribed from event type: ${eventType}`);
    }
  }
}
