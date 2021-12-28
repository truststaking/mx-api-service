import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ApiConfigService } from "src/common/api-config/api.config.service";
import { CachingService } from "src/common/caching/caching.service";
import { CacheInfo } from "src/common/caching/entities/cache.info";
import { ApiService } from "src/common/network/api.service";
import { MediaMimeTypeEnum } from "src/endpoints/nfts/entities/media.mime.type";
import { Nft } from "src/endpoints/nfts/entities/nft";
import { NftMedia } from "src/endpoints/nfts/entities/nft.media";
import { NftType } from "src/endpoints/nfts/entities/nft.type";
import { BinaryUtils } from "src/utils/binary.utils";
import { Constants } from "src/utils/constants";
import { TokenUtils } from "src/utils/token.utils";


@Injectable()
export class NftMediaService {
  private readonly logger: Logger;
  private readonly IPFS_REQUEST_TIMEOUT = Constants.oneSecond() * 30 * 1000;
  private readonly NFT_THUMBNAIL_PREFIX;

  constructor(
    private readonly cachingService: CachingService,
    private readonly apiService: ApiService,
    private readonly apiConfigService: ApiConfigService,
  ) {
    this.logger = new Logger(NftMediaService.name);
    this.NFT_THUMBNAIL_PREFIX = this.apiConfigService.getExternalMediaUrl() + '/nfts/asset'
  }

  async getMedia(nft: Nft, forceRefresh: boolean = false): Promise<NftMedia[] | undefined> {
    let media = await this.cachingService.getOrSetCache(
      CacheInfo.NftMedia(nft.identifier).key,
      async () => await this.getMediaRaw(nft),
      CacheInfo.NftMedia(nft.identifier).ttl,
      Constants.oneDay(),
      forceRefresh
    );

    if (!media) {
      return undefined;
    }

    return media;
  }

  async getMediaRaw(nft: Nft): Promise<NftMedia[] | null> {
    if (nft.type === NftType.MetaESDT) {
      return null;
    }

    if (!nft.uris) {
      return null;
    }

    const mediaArray: NftMedia[] = [];
    for (let uri of nft.uris) {
      if (!uri) {
        continue;
      }

      let fileProperties: { contentType: string, contentLength: number } | null = null;
        
      try {
        this.logger.log(`Started fetching media for nft with identifier '${nft.identifier}' and uri '${uri}'`);
        let url = this.getUrl(uri);

        fileProperties = await this.getFilePropertiesFromIpfs(url);
        this.logger.log(`Completed fetching media for nft with identifier '${nft.identifier}' and uri '${uri}'`);
      } catch (error) {
        this.logger.error(`Unexpected error when fetching media for nft with identifier '${nft.identifier}' and uri '${uri}'`);
        this.logger.error(error);
        throw error;
      }
      
      if (!fileProperties) {
        continue;
      }

      const nftMedia = new NftMedia();
      nftMedia.url = TokenUtils.computeNftUri(BinaryUtils.base64Decode(uri), this.NFT_THUMBNAIL_PREFIX);
      nftMedia.originalUrl = BinaryUtils.base64Decode(uri);
      nftMedia.thumbnailUrl = `${this.apiConfigService.getExternalMediaUrl()}/nfts/thumbnail/${nft.collection}-${TokenUtils.getUrlHash(nftMedia.url)}`
      nftMedia.fileType = fileProperties.contentType;
      nftMedia.fileSize = fileProperties.contentLength;

      mediaArray.push(nftMedia);
    }

    return mediaArray;
  }

  private getUrl(nftUri: string): string {
    let url = BinaryUtils.base64Decode(nftUri);
    if (url.startsWith('https://ipfs.io/ipfs')) {
      url = url.replace('https://ipfs.io/ipfs', this.apiConfigService.getIpfsUrl());
    }

    if (url.startsWith('ipfs://')) {
      url = url.replace('ipfs://', this.apiConfigService.getIpfsUrl() + '/');
    }

    return url;
  }

  private async getFilePropertiesFromIpfs(uri: string): Promise<{ contentType: string, contentLength: number } | null> {
    return this.cachingService.getOrSetCache(
      CacheInfo.NftMediaProperties(uri).key,
      async () => await this.getFilePropertiesFromIpfsRaw(uri),
      CacheInfo.NftMediaProperties(uri).ttl
    );
  }

  private async getFilePropertiesFromIpfsRaw(uri: string): Promise<{ contentType: string, contentLength: number } | null> {
    const response = await this.apiService.head(uri, { timeout: this.IPFS_REQUEST_TIMEOUT });
    if (response.status !== HttpStatus.OK) {
      this.logger.error(`Unexpected http status code '${response.status}' while fetching file properties from uri '${uri}'`);
      return null;
    }

    const { headers } = response;
    const contentType = headers['content-type'];
    const contentLength = Number(headers['content-length']);

    if (!this.isContentAccepted(contentType)) {
      return null;
    }

    return { contentType, contentLength };
  }

  private isContentAccepted(contentType: MediaMimeTypeEnum) {
    return Object.values(MediaMimeTypeEnum).includes(contentType);
  }
}