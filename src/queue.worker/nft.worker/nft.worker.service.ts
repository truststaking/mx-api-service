import { Injectable, Logger } from "@nestjs/common";
// import { InjectQueue } from "@nestjs/bull";
// import { Queue } from "bull";
import { Nft } from "src/endpoints/nfts/entities/nft";
import { ProcessNftSettings } from "src/endpoints/process-nfts/entities/process.nft.settings";
import { CacheInfo } from "src/common/caching/entities/cache.info";
import { CachingService } from "src/common/caching/caching.service";
import { NftThumbnailService } from "./queue/job-services/thumbnails/nft.thumbnail.service";
import { NftMetadataService } from "./queue/job-services/metadata/nft.metadata.service";
import { NftMediaService } from "./queue/job-services/media/nft.media.service";
import { NftMedia } from "src/endpoints/nfts/entities/nft.media";
import { TokenUtils } from "src/utils/token.utils";

@Injectable()
export class NftWorkerService {
  private readonly logger: Logger;

  constructor(
    // @InjectQueue('nftQueue') private nftQueue: Queue,
    private readonly cachingService: CachingService,
    private readonly nftThumbnailService: NftThumbnailService,
    private readonly nftMetadataService: NftMetadataService,
    private readonly nftMediaService: NftMediaService,
  ) {
    this.logger = new Logger(NftWorkerService.name);
  }

  async addProcessNftQueueJob(nft: Nft | undefined, settings: ProcessNftSettings): Promise<void> {
    if (!nft) {
      return;
    }

    let needsProcessing = await this.needsProcessing(nft, settings);
    if (!needsProcessing) {
      this.logger.log(`No processing is needed for nft with identifier '${nft.identifier}'`);
      return;
    }

    nft.metadata = await this.nftMetadataService.getMetadata(nft, settings.forceRefreshMetadata);
    nft.media = await this.nftMediaService.getMedia(nft, settings.forceRefreshMedia);

    if (nft.media && !settings.skipRefreshThumbnail) {
      await Promise.all(nft.media.map(media => this.generateThumbnail(nft, media, settings.forceRefreshThumbnail)));
    }

    // const job = await this.nftQueue.add({ identifier: nft.identifier, nft, settings }, {
    //   priority: 1000,
    //   attempts: 3,
    //   timeout: 60000,
    //   removeOnComplete: true
    // });
    // this.logger.log({ type: 'producer', jobId: job.id, identifier: job.data.identifier, settings });
  }

  private async generateThumbnail(nft: Nft, media: NftMedia, excludeThumbnail: boolean = false): Promise<void> {
    try {
      if (!excludeThumbnail) {
        await this.nftThumbnailService.generateThumbnail(nft, media.url, media.fileType);
      } else {
        const urlHash = TokenUtils.getUrlHash(media.url);
        this.logger.log(`Skip generating thumbnail for NFT with identifier '${nft.identifier}' and url hash '${urlHash}'`);
      }
    } catch (error) {
      this.logger.error(`An unhandled exception occurred when generating thumbnail for nft with identifier '${nft.identifier}' and url '${media.url}'`);
      this.logger.error(error);
      throw error;
    }
  }

  private async needsProcessing(nft: Nft, settings: ProcessNftSettings): Promise<boolean> {
    if (!settings.forceRefreshMedia) {
      let mediaKey = CacheInfo.NftMedia(nft.identifier).key;
      let mediaKeyResult = await this.cachingService.getKeys(mediaKey);
      if (mediaKeyResult.length === 0) {
        return true;
      }
    }

    if (!settings.forceRefreshMetadata) {
      let metadataKey = CacheInfo.NftMetadata(nft.identifier).key;
      let metadataKeyResult = await this.cachingService.getKeys(metadataKey);
      if (metadataKeyResult.length === 0) {
        return true;
      }
    }

    if (!settings.forceRefreshThumbnail && !settings.skipRefreshThumbnail) {
      if (nft.media) {
        for (let media of nft.media) {
          let hasThumbnailGenerated = await this.nftThumbnailService.hasThumbnailGenerated(nft.identifier, media.url);
          if (!hasThumbnailGenerated) {
            return true;
          }
        }
      }
    }

    return false;
  }
}