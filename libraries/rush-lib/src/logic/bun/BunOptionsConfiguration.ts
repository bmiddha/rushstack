// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import {
  IPackageManagerOptionsJsonBase,
  PackageManagerOptionsConfigurationBase
} from '../base/BasePackageManagerOptionsConfiguration';

/**
 * Part of IRushConfigurationJson.
 * @internal
 */
export interface IBunOptionsJson extends IPackageManagerOptionsJsonBase {
  /**
   * {@inheritDoc BunOptionsConfiguration.useWorkspaces}
   */
  useWorkspaces?: boolean;
}

/**
 * Options that are only used when the bun package manager is selected.
 *
 * @remarks
 * It is valid to define these options in rush.json even if the bun package manager
 * is not being used.
 *
 * @public
 */
export class BunOptionsConfiguration extends PackageManagerOptionsConfigurationBase {
  /**
   * If true, then Rush will use the workspaces feature to install and link packages when invoking PNPM.
   *
   * @remarks
   * The default value is true.  (For now.)
   */
  public readonly useWorkspaces: boolean;

  /** @internal */
  public constructor(json: IBunOptionsJson) {
    super(json);
    this.useWorkspaces = !!json.useWorkspaces;
  }
}
