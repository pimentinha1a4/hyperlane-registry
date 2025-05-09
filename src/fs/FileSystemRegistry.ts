import fs from 'fs';
import path from 'path';
import type { Logger } from 'pino';
import { parse as yamlParse } from 'yaml';

import type {
  ChainMap,
  ChainMetadata,
  ChainName,
  WarpCoreConfig,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';

import {
  CHAIN_FILE_REGEX,
  SCHEMA_REF,
  WARP_ROUTE_CONFIG_FILE_REGEX,
  WARP_ROUTE_DEPLOY_FILE_REGEX,
} from '../consts.js';
import { ChainAddresses, ChainAddressesSchema, WarpRouteId } from '../types.js';
import { toYamlString } from '../utils.js';

import {
  AddWarpRouteConfigOptions,
  RegistryType,
  UpdateChainParams,
  type AddWarpRouteOptions,
  type ChainFiles,
  type IRegistry,
  type RegistryContent,
} from '../registry/IRegistry.js';
import { SynchronousRegistry } from '../registry/SynchronousRegistry.js';
import { warpRouteConfigPathToId, warpRouteDeployConfigPathToId } from '../registry/warp-utils.js';

export interface FileSystemRegistryOptions {
  uri: string;
  logger?: Logger;
}

/**
 * A registry that uses a local file system path as its data source.
 * Requires file system access so it cannot be used in the browser.
 */
export class FileSystemRegistry extends SynchronousRegistry implements IRegistry {
  public readonly type = RegistryType.FileSystem;

  constructor(options: FileSystemRegistryOptions) {
    super(options);
  }

  getUri(itemPath?: string): string {
    if (!itemPath) return super.getUri();
    return path.join(this.uri, itemPath);
  }

  /**
   * Retrieves filepaths for chains, warp core, and warp deploy configs
   */
  listRegistryContent(): RegistryContent {
    if (this.listContentCache) return this.listContentCache;

    const chainFileList = this.listFiles(path.join(this.uri, this.getChainsPath()));
    const chains: ChainMap<ChainFiles> = {};
    for (const filePath of chainFileList) {
      const matches = filePath.match(CHAIN_FILE_REGEX);
      if (!matches) continue;
      const [_, chainName, fileName] = matches;
      chains[chainName] ??= {};
      // @ts-ignore allow dynamic key assignment
      chains[chainName][fileName] = filePath;
    }

    const warpRoutes: RegistryContent['deployments']['warpRoutes'] = {};
    const warpRouteFiles = this.listFiles(path.join(this.uri, this.getWarpRoutesPath()));
    for (const filePath of warpRouteFiles) {
      if (!WARP_ROUTE_CONFIG_FILE_REGEX.test(filePath)) continue;
      const routeId = warpRouteConfigPathToId(filePath);
      warpRoutes[routeId] = filePath;
    }

    const warpDeployConfig: RegistryContent['deployments']['warpDeployConfig'] = {};
    const warpDeployFiles = this.listFiles(path.join(this.uri, this.getWarpRoutesPath()));
    for (const filePath of warpDeployFiles) {
      if (!WARP_ROUTE_DEPLOY_FILE_REGEX.test(filePath)) continue;
      const routeId = warpRouteDeployConfigPathToId(filePath);
      warpDeployConfig[routeId] = filePath;
    }

    return (this.listContentCache = { chains, deployments: { warpRoutes, warpDeployConfig } });
  }

  getMetadata(): ChainMap<ChainMetadata> {
    if (this.metadataCache) return this.metadataCache;
    const chainMetadata: ChainMap<ChainMetadata> = {};
    const repoContents = this.listRegistryContent();
    for (const [chainName, chainFiles] of Object.entries(repoContents.chains)) {
      if (!chainFiles.metadata) continue;
      const data = fs.readFileSync(chainFiles.metadata, 'utf8');
      chainMetadata[chainName] = yamlParse(data);
    }
    return (this.metadataCache = chainMetadata);
  }

  getAddresses(): ChainMap<ChainAddresses> {
    if (this.addressCache) return this.addressCache;
    const chainAddresses: ChainMap<ChainAddresses> = {};
    const repoContents = this.listRegistryContent();
    for (const [chainName, chainFiles] of Object.entries(repoContents.chains)) {
      if (!chainFiles.addresses) continue;
      const data = fs.readFileSync(chainFiles.addresses, 'utf8');
      chainAddresses[chainName] = ChainAddressesSchema.parse(yamlParse(data));
    }
    return (this.addressCache = chainAddresses);
  }

  removeChain(chainName: ChainName): void {
    const chainFiles = this.listRegistryContent().chains[chainName];
    super.removeChain(chainName);
    this.removeFiles(Object.values(chainFiles));
  }

  addWarpRoute(config: WarpCoreConfig, options?: AddWarpRouteOptions): void {
    const configPath = this.getWarpRouteCoreConfigPath(config, options);
    this.createFile({
      filePath: path.join(this.uri, configPath),
      data: toYamlString(config, SCHEMA_REF),
    });
  }
  //TODO: This string parameter overload is for backwards compatibility with the export-warp-configs.ts script.
  //It should be removed when all consumers have been updated to use the options parameter.
  //See: https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/eb3054c59184573f67f79a801965c8e4cc2ed3ce/typescript/infra/scripts/warp-routes/export-warp-configs.ts#L35
  addWarpRouteConfig(warpConfig: WarpRouteDeployConfig, fileName: string): void;
  addWarpRouteConfig(warpConfig: WarpRouteDeployConfig, options: AddWarpRouteConfigOptions): void;
  addWarpRouteConfig(
    warpConfig: WarpRouteDeployConfig,
    fileNameOrOptions: string | AddWarpRouteConfigOptions,
  ): void {
    let filePath: string;

    if (typeof fileNameOrOptions === 'string') {
      filePath = path.join(this.uri, this.getWarpRoutesPath(), fileNameOrOptions);
    } else {
      filePath = this.getWarpRouteDeployConfigPath(warpConfig, fileNameOrOptions);
    }

    this.createFile({ filePath, data: toYamlString(warpConfig) });
  }

  protected listFiles(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) return [];

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const filePaths = entries.map((entry) => {
      const fullPath = path.join(dirPath, entry.name);
      return entry.isDirectory() ? this.listFiles(fullPath) : fullPath;
    });

    return filePaths.flat();
  }

  protected createOrUpdateChain(chain: UpdateChainParams): void {
    if (!chain.metadata && !chain.addresses)
      throw new Error(`Chain ${chain.chainName} must have metadata or addresses, preferably both`);

    const currentChains = this.listRegistryContent();
    if (!currentChains.chains[chain.chainName]) {
      this.logger.debug(`Chain ${chain.chainName} not found in registry, adding it now`);
    }

    if (chain.metadata) {
      this.createChainFile(
        chain.chainName,
        'metadata',
        chain.metadata,
        this.getMetadata(),
        SCHEMA_REF,
      );
    }
    if (chain.addresses) {
      this.createChainFile(chain.chainName, 'addresses', chain.addresses, this.getAddresses());
    }
  }

  protected createChainFile(
    chainName: ChainName,
    fileName: keyof ChainFiles,
    data: any,
    cache: ChainMap<any>,
    prefix?: string,
  ) {
    const filePath = path.join(this.uri, this.getChainsPath(), chainName, `${fileName}.yaml`);
    const currentChains = this.listRegistryContent().chains;
    currentChains[chainName] ||= {};
    currentChains[chainName][fileName] = filePath;
    cache[chainName] = data;
    this.createFile({ filePath, data: toYamlString(data, prefix) });
  }

  protected createFile(file: { filePath: string; data: string }): void {
    const dirPath = path.dirname(file.filePath);
    if (!fs.existsSync(dirPath))
      fs.mkdirSync(dirPath, {
        recursive: true,
      });
    fs.writeFileSync(file.filePath, file.data);
  }

  protected removeFiles(filePaths: string[]): void {
    for (const filePath of filePaths) {
      fs.unlinkSync(filePath);
    }
    const parentDir = path.dirname(filePaths[0]);
    if (fs.readdirSync(parentDir).length === 0) {
      fs.rmdirSync(parentDir);
    }
  }

  protected getWarpRoutesForIds(ids: WarpRouteId[]): WarpCoreConfig[] {
    const warpRoutes = this.listRegistryContent().deployments.warpRoutes;
    return this.readConfigsForIds(ids, warpRoutes);
  }

  protected getWarpDeployConfigForIds(ids: WarpRouteId[]): WarpRouteDeployConfig[] {
    const warpDeployConfig = this.listRegistryContent().deployments.warpDeployConfig;
    return this.readConfigsForIds(ids, warpDeployConfig);
  }

  /**
   * Reads config files for the given WarpRouteIds.
   * @param ids - The WarpRouteIds to read configs for.
   * @param configURIs - A mapping of WarpRouteIds to file paths where the configs are stored.
   * @returns An array of config objects.
   */
  protected readConfigsForIds<Config>(
    ids: WarpRouteId[],
    configURIs: Record<WarpRouteId, string>,
  ): Config[] {
    const configs: Config[] = [];
    for (const [id, filePath] of Object.entries(configURIs)) {
      if (!ids.includes(id)) continue;
      const data = fs.readFileSync(filePath, 'utf8');
      configs.push(yamlParse(data));
    }
    return configs;
  }
}
