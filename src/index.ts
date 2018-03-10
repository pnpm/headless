import {
  getCacheByEngine,
  PackageFilesResponse,
} from '@pnpm/package-requester'
import dp = require('dependency-path')
import pLimit = require('p-limit')
import {StoreController} from 'package-store'
import path = require('path')
import {
  PackageSnapshot,
  readWanted,
  Shrinkwrap,
} from 'pnpm-shrinkwrap'
import R = require('ramda')
import linkBins, {linkPkgBins} from 'supi/lib/link/linkBins' // TODO: move to separate package
import symlinkDir = require('symlink-dir')
import depSnapshotToResolution from './depSnapshotToResolution'

const ENGINE_NAME = `${process.platform}-${process.arch}-node-${process.version.split('.')[0]}`

export default async (
  opts: {
    development: boolean,
    optional: boolean,
    prefix: string,
    production: boolean,
    independentLeaves: boolean,
    storeController: StoreController,
    verifyStoreIntegrity: boolean,
    sideEffectsCache: boolean,
    force: boolean,
    storePath: string,
  },
) => {
  if (typeof opts.prefix !== 'string') {
    throw new TypeError('opts.prefix should be a string')
  }

  const wantedShrinkwrap = await readWanted(opts.prefix, {ignoreIncompatible: false})

  if (!wantedShrinkwrap) {
    throw new Error('Headless installation can be done only with a shrinkwrap.yaml file')
  }

  const filterOpts = {
    noDev: !opts.development,
    noOptional: !opts.optional,
    noProd: !opts.production,
  }
  const filteredShrinkwrap = filterShrinkwrap(wantedShrinkwrap, filterOpts)

  const depGraph = await shrinkwrapToDepGraph(filteredShrinkwrap, opts)

  await Promise.all([
    linkAllModules(depGraph, {optional: opts.optional}),
    linkAllPkgs(opts.storeController, R.values(depGraph), opts),
  ])

  await linkAllBins(depGraph, {optional: opts.optional})
}

async function shrinkwrapToDepGraph (
  shr: Shrinkwrap,
  opts: {
    force: boolean,
    independentLeaves: boolean,
    storeController: StoreController,
    storePath: string,
    prefix: string,
    verifyStoreIntegrity: boolean,
  },
) {
  const nodeModules = path.join(opts.prefix, 'node_modules')
  const graph: DepGraphNodesByDepPath = {}
  if (shr.packages) {
    for (const relDepPath of R.keys(shr.packages)) {
      const depPath = dp.resolve(shr.registry, relDepPath)
      const depSnapshot = shr.packages[relDepPath]
      const independent = opts.independentLeaves && R.isEmpty(depSnapshot.dependencies) && R.isEmpty(depSnapshot.optionalDependencies)
      const resolution = depSnapshotToResolution(relDepPath, depSnapshot, shr.registry)
      // TODO: optimize. This info can be already returned by depSnapshotToResolution()
      const pkgName = depSnapshot.name || dp.parse(relDepPath)['name'] // tslint:disable-line
      const pkgId = depSnapshot.id || depPath
      const fetchResponse = await opts.storeController.fetchPackage({
        force: false,
        pkgId,
        prefix: opts.prefix,
        resolution,
        verifyStoreIntegrity: opts.verifyStoreIntegrity,
      })
      const cacheByEngine = opts.force ? new Map() : await getCacheByEngine(opts.storePath, pkgId)
      const centralLocation = cacheByEngine[ENGINE_NAME] || path.join(fetchResponse.inStoreLocation, 'node_modules', pkgName)

      // TODO: make this work with local deps. Local deps have IDs that can be converted to location, only via `.${pkgIdToFilename(node.pkg.id)}`
      const modules = path.join(nodeModules, `.${depPath}`, 'node_modules')
      const peripheralLocation = !independent
        ? path.join(modules, pkgName)
        : centralLocation
      graph[depPath] = {
        centralLocation,
        children: getChildren(depSnapshot, shr.registry),
        fetchingFiles: fetchResponse.fetchingFiles,
        hasBundledDependencies: !!depSnapshot.bundledDependencies,
        independent,
        modules,
        optionalDependencies: new Set(R.keys(depSnapshot.optionalDependencies)),
        peripheralLocation,
      }
    }
  }
  return graph
}

function getChildren (depSnapshot: PackageSnapshot, registry: string) {
  const allDeps = Object.assign({}, depSnapshot.dependencies, depSnapshot.optionalDependencies)
  return R.keys(allDeps)
    .reduce((acc, alias) => {
      acc[alias] = dp.refToAbsolute(allDeps[alias], alias, registry)
      return acc
    }, {})
}

export interface DepGraphNode {
  // name: string,
  // at this point the version is really needed only for logging
  // version: string,
  hasBundledDependencies: boolean,
  centralLocation: string,
  modules: string,
  fetchingFiles: Promise<PackageFilesResponse>,
  peripheralLocation: string,
  children: {[alias: string]: string},
  // an independent package is a package that
  // has neither regular nor peer dependencies
  independent: boolean,
  optionalDependencies: Set<string>,
  // depth: number,
  // prod: boolean,
  // dev: boolean,
  // optional: boolean,
  // id: string,
  // installable: boolean,
  // additionalInfo: {
  //   deprecated?: string,
  //   peerDependencies?: Dependencies,
  //   bundleDependencies?: string[],
  //   bundledDependencies?: string[],
  //   engines?: {
  //     node?: string,
  //     npm?: string,
  //   },
  //   cpu?: string[],
  //   os?: string[],
  // },
  // isBuilt?: boolean,
}

export interface DepGraphNodesByDepPath {
  [depPath: string]: DepGraphNode
}

const limitLinking = pLimit(16)

async function linkAllPkgs (
  storeController: StoreController,
  depNodes: DepGraphNode[],
  opts: {
    force: boolean,
    sideEffectsCache: boolean,
  },
) {
  return Promise.all(
    depNodes.map(async (depNode) => {
      const filesResponse = await depNode.fetchingFiles

      // if (depNode.independent) return
      return storeController.importPackage(depNode.centralLocation, depNode.peripheralLocation, {
        filesResponse,
        force: opts.force,
      })
    }),
  )
}

async function linkAllBins (
  depGraph: DepGraphNodesByDepPath,
  opts: {
    optional: boolean,
  },
) {
  return Promise.all(
    R.values(depGraph).map((depNode) => limitLinking(async () => {
      const binPath = path.join(depNode.peripheralLocation, 'node_modules', '.bin')

      const childrenToLink = opts.optional
          ? depNode.children
          : R.keys(depNode.children)
            .reduce((nonOptionalChildren, childAlias) => {
              if (!depNode.optionalDependencies.has(childAlias)) {
                nonOptionalChildren[childAlias] = depNode.children[childAlias]
              }
              return nonOptionalChildren
            }, {})

      await Promise.all(
        R.keys(childrenToLink)
          // .filter((alias) => depGraph[childrenToLink[alias]].installable)
          .map((alias) => path.join(depNode.modules, alias))
          .map((target) => linkPkgBins(target, binPath)),
      )

      // link also the bundled dependencies` bins
      if (depNode.hasBundledDependencies) {
        const bundledModules = path.join(depNode.peripheralLocation, 'node_modules')
        await linkBins(bundledModules, binPath)
      }
    })),
  )
}

async function linkAllModules (
  depGraph: DepGraphNodesByDepPath,
  opts: {
    optional: boolean,
  },
) {
  return Promise.all(
    R.values(depGraph)
      .filter((depNode) => !depNode.independent)
      .map((depNode) => limitLinking(async () => {
        const childrenToLink = opts.optional
          ? depNode.children
          : R.keys(depNode.children)
            .reduce((nonOptionalChildren, childAlias) => {
              if (!depNode.optionalDependencies.has(childAlias)) {
                nonOptionalChildren[childAlias] = depNode.children[childAlias]
              }
              return nonOptionalChildren
            }, {})

        await Promise.all(
          R.keys(childrenToLink)
            .map(async (alias) => {
              const pkg = depGraph[childrenToLink[alias]]
              // if (!pkg.installable) return
              await symlinkDependencyTo(alias, pkg, depNode.modules)
            }),
        )
      })),
  )
}

function symlinkDependencyTo (alias: string, depNode: DepGraphNode, dest: string) {
  dest = path.join(dest, alias)
  return symlinkDir(depNode.peripheralLocation, dest)
}

// TODO: move this to separate package
// the version of the function which is in supi also accepts `opts.skip`
// headless will never skip anything
function filterShrinkwrap (
  shr: Shrinkwrap,
  opts: {
    noDev: boolean,
    noOptional: boolean,
    noProd: boolean,
  },
): Shrinkwrap {
  let pairs = R.toPairs<string, PackageSnapshot>(shr.packages || {})
  if (opts.noProd) {
    pairs = pairs.filter((pair) => pair[1].dev !== false || pair[1].optional)
  }
  if (opts.noDev) {
    pairs = pairs.filter((pair) => pair[1].dev !== true)
  }
  if (opts.noOptional) {
    pairs = pairs.filter((pair) => !pair[1].optional)
  }
  return {
    dependencies: opts.noProd ? {} : shr.dependencies || {},
    devDependencies: opts.noDev ? {} : shr.devDependencies || {},
    optionalDependencies: opts.noOptional ? {} : shr.optionalDependencies || {},
    packages: R.fromPairs(pairs),
    registry: shr.registry,
    shrinkwrapVersion: shr.shrinkwrapVersion,
    specifiers: shr.specifiers,
  } as Shrinkwrap
}
