// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { PackageManagerName } from '../api/packageManager/PackageManager';
import { PackageManagerOptionsConfigurationBase } from './base/BasePackageManagerOptionsConfiguration';
import { BaseShrinkwrapFile } from './base/BaseShrinkwrapFile';
import { NpmShrinkwrapFile } from './npm/NpmShrinkwrapFile';
import { PnpmShrinkwrapFile } from './pnpm/PnpmShrinkwrapFile';
import { YarnShrinkwrapFile } from './yarn/YarnShrinkwrapFile';
import { BunShrinkwrapFile } from './bun/BunShrinkwrapFile';

export class ShrinkwrapFileFactory {
  public static getShrinkwrapFile(
    packageManager: PackageManagerName,
    packageManagerOptions: PackageManagerOptionsConfigurationBase,
    shrinkwrapFilename: string
  ): BaseShrinkwrapFile | undefined {
    switch (packageManager) {
      case 'npm':
        return NpmShrinkwrapFile.loadFromFile(shrinkwrapFilename);
      case 'pnpm':
        return PnpmShrinkwrapFile.loadFromFile(shrinkwrapFilename);
      case 'yarn':
        return YarnShrinkwrapFile.loadFromFile(shrinkwrapFilename);
      case 'bun':
        return BunShrinkwrapFile.loadFromFile(shrinkwrapFilename);
      default:
        throw new Error(`Invalid package manager: ${packageManager}`);
    }
  }

  public static parseShrinkwrapFile(
    packageManager: PackageManagerName,
    packageManagerOptions: PackageManagerOptionsConfigurationBase,
    shrinkwrapContent: string
  ): BaseShrinkwrapFile | undefined {
    switch (packageManager) {
      case 'npm':
        return NpmShrinkwrapFile.loadFromString(shrinkwrapContent);
      case 'pnpm':
        return PnpmShrinkwrapFile.loadFromString(shrinkwrapContent);
      case 'bun':
        return BunShrinkwrapFile.loadFromString(shrinkwrapContent);
      default:
        throw new Error(`Invalid package manager: ${packageManager}`);
    }
  }
}
