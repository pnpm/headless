import {PackageFilesResponse} from '@pnpm/package-requester'
import dp = require('dependency-path')
import pLimit = require('p-limit')
import {StoreController} from 'package-store'
import path = require('path')
import {
  readWanted,
  Shrinkwrap,
  PackageSnapshot,
} from 'pnpm-shrinkwrap'
import R = require('ramda')
import depSnapshotToResolution from './depSnapshotToResolution'

export default async (
  pkgPath: string,
  opts: {
    development: boolean,
    optional: boolean,
    production: boolean,
    independentLeaves: boolean,
  },
) => {
  if (typeof pkgPath !== 'string') {
    throw new TypeError('pkgPath should be a string')
  }

  const wantedShrinkwrap = await readWanted(pkgPath, {ignoreIncompatible: false})

  if (!wantedShrinkwrap) {
    throw new Error('Headless installation can be done only with a shrinkwrap.yaml file')
  }

  const filterOpts = {
    noDev: !opts.development,
    noOptional: !opts.optional,
    noProd: !opts.production,
  }
  const filteredShrinkwrap = filterShrinkwrap(wantedShrinkwrap, filterOpts)

  await Promise.all([
    linkAllModules(newPkgs, depGraph, {optional: opts.optional}),
    linkAllModules(existingWithUpdatedDeps, depGraph, {optional: opts.optional}),
    linkAllPkgs(opts.storeController, newPkgs, opts),
  ])

  await linkAllBins(newPkgs, depGraph, {optional: opts.optional})
}

function shrinkwrapToDepGraph (
  shr: Shrinkwrap,
  opts: {
    independentLeaves: boolean,
    storeController: StoreController,
  },
) {
  const graph: DepGraphNodesByDepPath = {}
  if (shr.packages) {
    for (const relDepPath of R.keys(shr.packages)) {
      const depPath = dp.resolve(shr.registry, relDepPath)
      const depSnapshot = shr.packages[relDepPath]
      const independent = opts.independentLeaves && R.isEmpty(depSnapshot.dependencies) && R.isEmpty(depSnapshot.optionalDependencies)
      const resolution = depSnapshotToResolution(relDepPath, depSnapshot, shr.registry)
      const pkgResponse = opts.storeController.requestPackage({}, {

      })
      graph[depPath] = {
        independent,
        hasBundledDependencies: !!depSnapshot.bundledDependencies,
      }
    }
  }
  return graph
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
  depNodes: DepGraphNode[],
  depGraph: DepGraphNodesByDepPath,
  opts: {
    optional: boolean,
  },
) {
  return Promise.all(
    depNodes.map((depNode) => limitLinking(async () => {
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
  depNodes: DepGraphNode[],
  depGraph: DepGraphNodesByDepPath,
  opts: {
    optional: boolean,
  },
) {
  return Promise.all(
    depNodes
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
