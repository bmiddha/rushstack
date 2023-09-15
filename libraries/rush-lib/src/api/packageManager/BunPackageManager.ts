// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { RushConstants } from '../../logic/RushConstants';
import { PackageManager } from './PackageManager';

/**
 * Support for interacting with the Bun package manager.
 */
export class BunPackageManager extends PackageManager {
  /** @internal */
  public constructor(version: string) {
    super(version, 'bun', RushConstants.bunShrinkwrapFilename);
  }
}
