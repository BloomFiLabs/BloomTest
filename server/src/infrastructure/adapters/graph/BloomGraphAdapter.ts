import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { gql, GraphQLClient } from 'graphql-request';

export interface SubgraphWithdrawalRequest {
  id: string;
  sharesEscrow: string;
  owner: string;
  claimableAt: string;
  requestedAt: string;
}

@Injectable()
export class BloomGraphAdapter {
  private readonly logger = new Logger(BloomGraphAdapter.name);
  private client: GraphQLClient;

  constructor(private configService: ConfigService) {
    const subgraphUrl = this.configService.get<string>('BLOOM_SUBGRAPH_URL');
    const apiKey = this.configService.get<string>('GRAPH_API_KEY');

    if (!subgraphUrl) {
      this.logger.warn('BLOOM_SUBGRAPH_URL not configured');
    } else {
      this.logger.log(`BloomGraphAdapter initialized with URL: ${subgraphUrl}`);
    }

    this.client = new GraphQLClient(subgraphUrl || '', {
      headers: apiKey
        ? {
            Authorization: `Bearer ${apiKey}`,
          }
        : {},
    });
  }

  async getPendingWithdrawals(): Promise<SubgraphWithdrawalRequest[]> {
    const query = gql`
      query GetWithdrawalRequests {
        withdrawalRequests(
          first: 100
          orderBy: requestedAt
          orderDirection: asc
        ) {
          id
          sharesEscrow
          owner
          claimableAt
          requestedAt
        }
      }
    `;

    try {
      const data = await this.client.request<{
        withdrawalRequests: SubgraphWithdrawalRequest[];
      }>(query);
      return data.withdrawalRequests;
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch withdrawal requests: ${error.message}`,
      );
      return [];
    }
  }
}
