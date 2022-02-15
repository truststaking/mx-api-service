import { Controller, Logger } from "@nestjs/common";
import { Ctx, MessagePattern, Payload, RmqContext } from "@nestjs/microservices";
import { ApiConfigService } from "src/common/api-config/api.config.service";
import { Nft } from "src/endpoints/nfts/entities/nft";
import { NftMedia } from "src/endpoints/nfts/entities/nft.media";
import { NftMessage } from "./entities/nft.message";
import { NftMediaService } from "./job-services/media/nft.media.service";
import { NftMetadataService } from "./job-services/metadata/nft.metadata.service";
import { GenerateThumbnailResult } from "./job-services/thumbnails/entities/generate.thumbnail.result";
import { NftThumbnailService } from "./job-services/thumbnails/nft.thumbnail.service";

@Controller()
export class NftQueueController {
  private readonly logger: Logger;
  private readonly RETRY_LIMIT: Number;

  constructor(
    private readonly nftMetadataService: NftMetadataService,
    private readonly nftMediaService: NftMediaService,
    private readonly nftThumbnailService: NftThumbnailService,
    apiConfigService: ApiConfigService,
  ) {
    this.logger = new Logger(NftQueueController.name);
    this.RETRY_LIMIT = apiConfigService.getNftProcessMaxRetries();
  }

  private getAttempt(msg: any): number {
    const headers = msg.properties.headers;

    let attempt = 0;
    if (headers['x-death']) {
      const currentXDeath = headers['x-death'][0];
      if (currentXDeath) {
        attempt = currentXDeath.count;
      }
    }

    return attempt;
  }

  @MessagePattern({ cmd: 'api-process-nfts' })
  async onNftCreated(@Payload() data: NftMessage, @Ctx() context: RmqContext) {
    const channel = context.getChannelRef();
    const message = context.getMessage();
    const attempt = this.getAttempt(message);

    if (attempt >= this.RETRY_LIMIT) {
      this.logger.log(`NFT ${data.identifier} reached maximum number of retries (${this.RETRY_LIMIT})! Removed from retry exchange!`);
      channel.ack(message);
      return;
    }

    this.logger.log({ type: 'consumer start', identifier: data.identifier, attempt });

    try {
      const nft = data.nft;
      const settings = data.settings;

      nft.metadata = await this.nftMetadataService.getMetadata(nft);

      if (settings.forceRefreshMetadata || !nft.metadata) {
        nft.metadata = await this.nftMetadataService.refreshMetadata(nft);
      }

      nft.media = await this.nftMediaService.getMedia(nft) ?? undefined;

      if (settings.forceRefreshMedia || !nft.media) {
        nft.media = await this.nftMediaService.refreshMedia(nft);
      }

      if (nft.media && !settings.skipRefreshThumbnail) {
        await Promise.all(nft.media.map((media: any) => this.generateThumbnail(nft, media, settings.forceRefreshThumbnail)));
      }

      this.logger.log({ type: 'consumer end', identifier: data.identifier });

      channel.ack(message);
    } catch (error: any) {
      this.logger.error(`Unexpected error when processing NFT with identifier '${data.identifier}'`);
      this.logger.error(error);

      channel.reject(message, false);
    }
  }

  private async generateThumbnail(nft: Nft, media: NftMedia, forceRefresh: boolean = false): Promise<void> {
    let result: GenerateThumbnailResult;
    try {
      result = await this.nftThumbnailService.generateThumbnail(nft, media.url, media.fileType, forceRefresh);
    } catch (error) {
      this.logger.error(`An unhandled exception occurred when generating thumbnail for nft with identifier '${nft.identifier}' and url '${media.url}'`);
      this.logger.error(error);
      throw error;
    }

    if (result === GenerateThumbnailResult.couldNotExtractThumbnail) {
      throw new Error(`Could not extract thumbnail for for nft with identifier '${nft.identifier}' and url '${media.url}'`);
    }
  }
}