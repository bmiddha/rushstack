// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as ts from 'typescript';
import { Text, InternalError } from '@rushstack/node-core-library';
import { ReleaseTag } from '@microsoft/api-extractor-model';

import { Collector } from '../collector/Collector';
import { TypeScriptHelpers } from '../analyzer/TypeScriptHelpers';
import { Span } from '../analyzer/Span';
import type { CollectorEntity } from '../collector/CollectorEntity';
import { AstDeclaration } from '../analyzer/AstDeclaration';
import type { ApiItemMetadata } from '../collector/ApiItemMetadata';
import { AstImport } from '../analyzer/AstImport';
import { AstSymbol } from '../analyzer/AstSymbol';
import type { ExtractorMessage } from '../api/ExtractorMessage';
import { IndentedWriter } from './IndentedWriter';
import { DtsEmitHelpers } from './DtsEmitHelpers';
import { AstNamespaceImport } from '../analyzer/AstNamespaceImport';
import type { AstEntity } from '../analyzer/AstEntity';
import type { AstModuleExportInfo } from '../analyzer/AstModule';
import { SourceFileLocationFormatter } from '../analyzer/SourceFileLocationFormatter';
import { ExtractorMessageId } from '../api/ExtractorMessageId';

/**
 * Represents the minimum release tag level to be included in an API report.
 */
export enum ApiReportReleaseLevel {
  /**
   * Include all exports, regardless of release tags.
   */
  Untrimmed = 0,

  /**
   * Include exports tagged with `@alpha`, `@beta`, or `@public`.
   */
  Alpha = 1,

  /**
   * Include exports tagged with `@beta` or `@public`.
   */
  Beta = 2,

  /**
   * Include exports tagged with `@public`.
   */
  Public = 3
}

/**
 * Options for {@link ApiReportGenerator.generateReviewFileContent}.
 */
export interface IApiReportOptions {
  /**
   * The release level with which the report is associated.
   * Can also be viewed as the minimal release level of items that should be included in the report.
   */
  readonly releaseLevel: ApiReportReleaseLevel;
}

export class ApiReportGenerator {
  private static _trimSpacesRegExp: RegExp = / +$/gm;

  /**
   * Compares the contents of two API files that were created using ApiFileGenerator,
   * and returns true if they are equivalent.  Note that these files are not normally edited
   * by a human; the "equivalence" comparison here is intended to ignore spurious changes that
   * might be introduced by a tool, e.g. Git newline normalization or an editor that strips
   * whitespace when saving.
   */
  public static areEquivalentApiFileContents(
    actualFileContent: string,
    expectedFileContent: string
  ): boolean {
    // NOTE: "\s" also matches "\r" and "\n"
    const normalizedActual: string = actualFileContent.replace(/[\s]+/g, ' ');
    const normalizedExpected: string = expectedFileContent.replace(/[\s]+/g, ' ');
    return normalizedActual === normalizedExpected;
  }

  public static generateReviewFileContent(collector: Collector, options: IApiReportOptions): string {
    const writer: IndentedWriter = new IndentedWriter();
    writer.trimLeadingSpaces = true;

    writer.writeLine(
      [
        `## API Report File for "${collector.workingPackage.name}"`,
        ``,
        `> Do not edit this file. It is a report generated by [API Extractor](https://api-extractor.com/).`,
        ``
      ].join('\n')
    );

    // Write the opening delimiter for the Markdown code fence
    writer.writeLine('```ts\n');

    // Emit the triple slash directives
    for (const typeDirectiveReference of Array.from(collector.dtsTypeReferenceDirectives).sort()) {
      // https://github.com/microsoft/TypeScript/blob/611ebc7aadd7a44a4c0447698bfda9222a78cb66/src/compiler/declarationEmitter.ts#L162
      writer.writeLine(`/// <reference types="${typeDirectiveReference}" />`);
    }
    for (const libDirectiveReference of Array.from(collector.dtsLibReferenceDirectives).sort()) {
      writer.writeLine(`/// <reference lib="${libDirectiveReference}" />`);
    }
    writer.ensureSkippedLine();

    // Emit the imports
    for (const entity of collector.entities) {
      if (entity.astEntity instanceof AstImport) {
        DtsEmitHelpers.emitImport(writer, entity, entity.astEntity);
      }
    }
    writer.ensureSkippedLine();

    // Emit the regular declarations
    for (const entity of collector.entities) {
      const astEntity: AstEntity = entity.astEntity;
      if (entity.consumable || collector.extractorConfig.apiReportIncludeForgottenExports) {
        // First, collect the list of export names for this symbol.  When reporting messages with
        // ExtractorMessage.properties.exportName, this will enable us to emit the warning comments alongside
        // the associated export statement.
        interface IExportToEmit {
          readonly exportName: string;
          readonly associatedMessages: ExtractorMessage[];
        }
        const exportsToEmit: Map<string, IExportToEmit> = new Map<string, IExportToEmit>();

        for (const exportName of entity.exportNames) {
          if (!entity.shouldInlineExport) {
            exportsToEmit.set(exportName, { exportName, associatedMessages: [] });
          }
        }

        if (astEntity instanceof AstSymbol) {
          // Emit all the declarations for this entity
          for (const astDeclaration of astEntity.astDeclarations || []) {
            // Get the messages associated with this declaration
            const fetchedMessages: ExtractorMessage[] =
              collector.messageRouter.fetchAssociatedMessagesForReviewFile(astDeclaration);

            // Peel off the messages associated with an export statement and store them
            // in IExportToEmit.associatedMessages (to be processed later).  The remaining messages will
            // added to messagesToReport, to be emitted next to the declaration instead of the export statement.
            const messagesToReport: ExtractorMessage[] = [];
            for (const message of fetchedMessages) {
              if (message.properties.exportName) {
                const exportToEmit: IExportToEmit | undefined = exportsToEmit.get(
                  message.properties.exportName
                );
                if (exportToEmit) {
                  exportToEmit.associatedMessages.push(message);
                  continue;
                }
              }
              messagesToReport.push(message);
            }

            writer.ensureSkippedLine();
            writer.write(ApiReportGenerator._getAedocSynopsis(collector, astDeclaration, messagesToReport));

            const span: Span = new Span(astDeclaration.declaration);

            const apiItemMetadata: ApiItemMetadata = collector.fetchApiItemMetadata(astDeclaration);
            if (apiItemMetadata.isPreapproved) {
              ApiReportGenerator._modifySpanForPreapproved(span);
            } else {
              ApiReportGenerator._modifySpan(
                collector,
                span,
                entity,
                astDeclaration,
                false,
                options.releaseLevel
              );
            }

            span.writeModifiedText(writer);
            writer.ensureNewLine();
          }
        }

        if (astEntity instanceof AstNamespaceImport) {
          const astModuleExportInfo: AstModuleExportInfo = astEntity.fetchAstModuleExportInfo(collector);

          if (entity.nameForEmit === undefined) {
            // This should never happen
            throw new InternalError('referencedEntry.nameForEmit is undefined');
          }

          if (astModuleExportInfo.starExportedExternalModules.size > 0) {
            // We could support this, but we would need to find a way to safely represent it.
            throw new Error(
              `The ${entity.nameForEmit} namespace import includes a star export, which is not supported:\n` +
                SourceFileLocationFormatter.formatDeclaration(astEntity.declaration)
            );
          }

          // Emit a synthetic declaration for the namespace.  It will look like this:
          //
          //    declare namespace example {
          //      export {
          //        f1,
          //        f2
          //      }
          //    }
          //
          // Note that we do not try to relocate f1()/f2() to be inside the namespace because other type
          // signatures may reference them directly (without using the namespace qualifier).

          writer.ensureSkippedLine();
          writer.writeLine(`declare namespace ${entity.nameForEmit} {`);

          // all local exports of local imported module are just references to top-level declarations
          writer.increaseIndent();
          writer.writeLine('export {');
          writer.increaseIndent();

          const exportClauses: string[] = [];
          for (const [exportedName, exportedEntity] of astModuleExportInfo.exportedLocalEntities) {
            const collectorEntity: CollectorEntity | undefined =
              collector.tryGetCollectorEntity(exportedEntity);
            if (collectorEntity === undefined) {
              // This should never happen
              // top-level exports of local imported module should be added as collector entities before
              throw new InternalError(
                `Cannot find collector entity for ${entity.nameForEmit}.${exportedEntity.localName}`
              );
            }

            if (collectorEntity.nameForEmit === exportedName) {
              exportClauses.push(collectorEntity.nameForEmit);
            } else {
              exportClauses.push(`${collectorEntity.nameForEmit} as ${exportedName}`);
            }
          }
          writer.writeLine(exportClauses.join(',\n'));

          writer.decreaseIndent();
          writer.writeLine('}'); // end of "export { ... }"
          writer.decreaseIndent();
          writer.writeLine('}'); // end of "declare namespace { ... }"
        }

        // Now emit the export statements for this entity.
        for (const exportToEmit of exportsToEmit.values()) {
          // Write any associated messages
          if (exportToEmit.associatedMessages.length > 0) {
            writer.ensureSkippedLine();
            for (const message of exportToEmit.associatedMessages) {
              ApiReportGenerator._writeLineAsComments(
                writer,
                'Warning: ' + message.formatMessageWithoutLocation()
              );
            }
          }

          DtsEmitHelpers.emitNamedExport(writer, exportToEmit.exportName, entity);
        }
        writer.ensureSkippedLine();
      }
    }

    DtsEmitHelpers.emitStarExports(writer, collector);

    // Write the unassociated warnings at the bottom of the file
    const unassociatedMessages: ExtractorMessage[] =
      collector.messageRouter.fetchUnassociatedMessagesForReviewFile();
    if (unassociatedMessages.length > 0) {
      writer.ensureSkippedLine();
      ApiReportGenerator._writeLineAsComments(writer, 'Warnings were encountered during analysis:');
      ApiReportGenerator._writeLineAsComments(writer, '');
      for (const unassociatedMessage of unassociatedMessages) {
        ApiReportGenerator._writeLineAsComments(
          writer,
          unassociatedMessage.formatMessageWithLocation(collector.workingPackage.packageFolder)
        );
      }
    }

    if (collector.workingPackage.tsdocComment === undefined) {
      writer.ensureSkippedLine();
      ApiReportGenerator._writeLineAsComments(writer, '(No @packageDocumentation comment for this package)');
    }

    // Write the closing delimiter for the Markdown code fence
    writer.ensureSkippedLine();
    writer.writeLine('```');

    // Remove any trailing spaces
    return writer.toString().replace(ApiReportGenerator._trimSpacesRegExp, '');
  }

  /**
   * Before writing out a declaration, _modifySpan() applies various fixups to make it nice.
   */
  private static _modifySpan(
    collector: Collector,
    span: Span,
    entity: CollectorEntity,
    astDeclaration: AstDeclaration,
    insideTypeLiteral: boolean,
    releaseLevel: ApiReportReleaseLevel
  ): void {
    // Should we process this declaration at all?
    // eslint-disable-next-line no-bitwise
    if (!ApiReportGenerator._shouldIncludeInReport(collector, astDeclaration, releaseLevel)) {
      span.modification.skipAll();
      return;
    }

    const previousSpan: Span | undefined = span.previousSibling;

    let recurseChildren: boolean = true;
    let sortChildren: boolean = false;

    switch (span.kind) {
      case ts.SyntaxKind.JSDocComment:
        span.modification.skipAll();
        // For now, we don't transform JSDoc comment nodes at all
        recurseChildren = false;
        break;

      case ts.SyntaxKind.ExportKeyword:
      case ts.SyntaxKind.DefaultKeyword:
      case ts.SyntaxKind.DeclareKeyword:
        // Delete any explicit "export" or "declare" keywords -- we will re-add them below
        span.modification.skipAll();
        break;

      case ts.SyntaxKind.InterfaceKeyword:
      case ts.SyntaxKind.ClassKeyword:
      case ts.SyntaxKind.EnumKeyword:
      case ts.SyntaxKind.NamespaceKeyword:
      case ts.SyntaxKind.ModuleKeyword:
      case ts.SyntaxKind.TypeKeyword:
      case ts.SyntaxKind.FunctionKeyword:
        // Replace the stuff we possibly deleted above
        let replacedModifiers: string = '';

        if (entity.shouldInlineExport) {
          replacedModifiers = 'export ' + replacedModifiers;
        }

        if (previousSpan && previousSpan.kind === ts.SyntaxKind.SyntaxList) {
          // If there is a previous span of type SyntaxList, then apply it before any other modifiers
          // (e.g. "abstract") that appear there.
          previousSpan.modification.prefix = replacedModifiers + previousSpan.modification.prefix;
        } else {
          // Otherwise just stick it in front of this span
          span.modification.prefix = replacedModifiers + span.modification.prefix;
        }
        break;

      case ts.SyntaxKind.SyntaxList:
        if (span.parent) {
          if (AstDeclaration.isSupportedSyntaxKind(span.parent.kind)) {
            // If the immediate parent is an API declaration, and the immediate children are API declarations,
            // then sort the children alphabetically
            sortChildren = true;
          } else if (span.parent.kind === ts.SyntaxKind.ModuleBlock) {
            // Namespaces are special because their chain goes ModuleDeclaration -> ModuleBlock -> SyntaxList
            sortChildren = true;
          }
        }
        break;

      case ts.SyntaxKind.VariableDeclaration:
        if (!span.parent) {
          // The VariableDeclaration node is part of a VariableDeclarationList, however
          // the Entry.followedSymbol points to the VariableDeclaration part because
          // multiple definitions might share the same VariableDeclarationList.
          //
          // Since we are emitting a separate declaration for each one, we need to look upwards
          // in the ts.Node tree and write a copy of the enclosing VariableDeclarationList
          // content (e.g. "var" from "var x=1, y=2").
          const list: ts.VariableDeclarationList | undefined = TypeScriptHelpers.matchAncestor(span.node, [
            ts.SyntaxKind.VariableDeclarationList,
            ts.SyntaxKind.VariableDeclaration
          ]);
          if (!list) {
            // This should not happen unless the compiler API changes somehow
            throw new InternalError('Unsupported variable declaration');
          }
          const listPrefix: string = list
            .getSourceFile()
            .text.substring(list.getStart(), list.declarations[0].getStart());
          span.modification.prefix = listPrefix + span.modification.prefix;
          span.modification.suffix = ';';

          if (entity.shouldInlineExport) {
            span.modification.prefix = 'export ' + span.modification.prefix;
          }
        }
        break;

      case ts.SyntaxKind.Identifier:
        const referencedEntity: CollectorEntity | undefined = collector.tryGetEntityForNode(
          span.node as ts.Identifier
        );

        if (referencedEntity) {
          if (!referencedEntity.nameForEmit) {
            // This should never happen
            throw new InternalError('referencedEntry.nameForEmit is undefined');
          }

          span.modification.prefix = referencedEntity.nameForEmit;
          // For debugging:
          // span.modification.prefix += '/*R=FIX*/';
        } else {
          // For debugging:
          // span.modification.prefix += '/*R=KEEP*/';
        }

        break;

      case ts.SyntaxKind.TypeLiteral:
        insideTypeLiteral = true;
        break;

      case ts.SyntaxKind.ImportType:
        DtsEmitHelpers.modifyImportTypeSpan(
          collector,
          span,
          astDeclaration,
          (childSpan, childAstDeclaration) => {
            ApiReportGenerator._modifySpan(
              collector,
              childSpan,
              entity,
              childAstDeclaration,
              insideTypeLiteral,
              releaseLevel
            );
          }
        );
        break;
    }

    if (recurseChildren) {
      for (const child of span.children) {
        let childAstDeclaration: AstDeclaration = astDeclaration;

        if (AstDeclaration.isSupportedSyntaxKind(child.kind)) {
          childAstDeclaration = collector.astSymbolTable.getChildAstDeclarationByNode(
            child.node,
            astDeclaration
          );

          if (ApiReportGenerator._shouldIncludeInReport(collector, childAstDeclaration, releaseLevel)) {
            if (sortChildren) {
              span.modification.sortChildren = true;
              child.modification.sortKey = Collector.getSortKeyIgnoringUnderscore(
                childAstDeclaration.astSymbol.localName
              );
            }

            if (!insideTypeLiteral) {
              const messagesToReport: ExtractorMessage[] =
                collector.messageRouter.fetchAssociatedMessagesForReviewFile(childAstDeclaration);

              // NOTE: This generates ae-undocumented messages as a side effect
              const aedocSynopsis: string = ApiReportGenerator._getAedocSynopsis(
                collector,
                childAstDeclaration,
                messagesToReport
              );

              child.modification.prefix = aedocSynopsis + child.modification.prefix;
            }
          }
        }

        ApiReportGenerator._modifySpan(
          collector,
          child,
          entity,
          childAstDeclaration,
          insideTypeLiteral,
          releaseLevel
        );
      }
    }
  }

  private static _shouldIncludeInReport(
    collector: Collector,
    astDeclaration: AstDeclaration,
    releaseLevel: ApiReportReleaseLevel
  ): boolean {
    // Private declarations are not included in the API report
    // eslint-disable-next-line no-bitwise
    if ((astDeclaration.modifierFlags & ts.ModifierFlags.Private) !== 0) {
      return false;
    }

    const apiItemMetadata: ApiItemMetadata = collector.fetchApiItemMetadata(astDeclaration);

    // No specified release tag is considered the same as `@public`.
    const releaseTag: ReleaseTag =
      apiItemMetadata.effectiveReleaseTag === ReleaseTag.None
        ? ReleaseTag.Public
        : apiItemMetadata.effectiveReleaseTag;

    // If the declaration has a release tag that is not in scope, omit it from the report.
    switch (releaseLevel) {
      case ApiReportReleaseLevel.Untrimmed:
        return true;
      case ApiReportReleaseLevel.Alpha:
        return releaseTag >= ReleaseTag.Alpha;
      case ApiReportReleaseLevel.Beta:
        return releaseTag >= ReleaseTag.Beta;
      case ApiReportReleaseLevel.Public:
        return releaseTag === ReleaseTag.Public;
      default:
        throw new Error(`Unrecognized release level: ${releaseLevel}`);
    }
  }

  /**
   * For declarations marked as `@preapproved`, this is used instead of _modifySpan().
   */
  private static _modifySpanForPreapproved(span: Span): void {
    // Match something like this:
    //
    //   ClassDeclaration:
    //     SyntaxList:
    //       ExportKeyword:  pre=[export] sep=[ ]
    //       DeclareKeyword:  pre=[declare] sep=[ ]
    //     ClassKeyword:  pre=[class] sep=[ ]
    //     Identifier:  pre=[_PreapprovedClass] sep=[ ]
    //     FirstPunctuation:  pre=[{] sep=[\n\n    ]
    //     SyntaxList:
    //       ...
    //     CloseBraceToken:  pre=[}]
    //
    // or this:
    //   ModuleDeclaration:
    //     SyntaxList:
    //       ExportKeyword:  pre=[export] sep=[ ]
    //       DeclareKeyword:  pre=[declare] sep=[ ]
    //     NamespaceKeyword:  pre=[namespace] sep=[ ]
    //     Identifier:  pre=[_PreapprovedNamespace] sep=[ ]
    //     ModuleBlock:
    //       FirstPunctuation:  pre=[{] sep=[\n\n    ]
    //       SyntaxList:
    //         ...
    //       CloseBraceToken:  pre=[}]
    //
    // And reduce it to something like this:
    //
    //   // @internal (undocumented)
    //   class _PreapprovedClass { /* (preapproved) */ }
    //

    let skipRest: boolean = false;
    for (const child of span.children) {
      if (skipRest || child.kind === ts.SyntaxKind.SyntaxList || child.kind === ts.SyntaxKind.JSDocComment) {
        child.modification.skipAll();
      }
      if (child.kind === ts.SyntaxKind.Identifier) {
        skipRest = true;
        child.modification.omitSeparatorAfter = true;
        child.modification.suffix = ' { /* (preapproved) */ }';
      }
    }
  }

  /**
   * Writes a synopsis of the AEDoc comments, which indicates the release tag,
   * whether the item has been documented, and any warnings that were detected
   * by the analysis.
   */
  private static _getAedocSynopsis(
    collector: Collector,
    astDeclaration: AstDeclaration,
    messagesToReport: ExtractorMessage[]
  ): string {
    const writer: IndentedWriter = new IndentedWriter();

    for (const message of messagesToReport) {
      ApiReportGenerator._writeLineAsComments(writer, 'Warning: ' + message.formatMessageWithoutLocation());
    }

    if (!collector.isAncillaryDeclaration(astDeclaration)) {
      const footerParts: string[] = [];
      const apiItemMetadata: ApiItemMetadata = collector.fetchApiItemMetadata(astDeclaration);
      if (!apiItemMetadata.releaseTagSameAsParent) {
        if (apiItemMetadata.effectiveReleaseTag !== ReleaseTag.None) {
          footerParts.push(ReleaseTag.getTagName(apiItemMetadata.effectiveReleaseTag));
        }
      }

      if (apiItemMetadata.isSealed) {
        footerParts.push('@sealed');
      }

      if (apiItemMetadata.isVirtual) {
        footerParts.push('@virtual');
      }

      if (apiItemMetadata.isOverride) {
        footerParts.push('@override');
      }

      if (apiItemMetadata.isEventProperty) {
        footerParts.push('@eventProperty');
      }

      if (apiItemMetadata.tsdocComment) {
        if (apiItemMetadata.tsdocComment.deprecatedBlock) {
          footerParts.push('@deprecated');
        }
      }

      if (apiItemMetadata.undocumented) {
        footerParts.push('(undocumented)');

        collector.messageRouter.addAnalyzerIssue(
          ExtractorMessageId.Undocumented,
          `Missing documentation for "${astDeclaration.astSymbol.localName}".`,
          astDeclaration
        );
      }

      if (footerParts.length > 0) {
        if (messagesToReport.length > 0) {
          ApiReportGenerator._writeLineAsComments(writer, ''); // skip a line after the warnings
        }

        ApiReportGenerator._writeLineAsComments(writer, footerParts.join(' '));
      }
    }

    return writer.toString();
  }

  private static _writeLineAsComments(writer: IndentedWriter, line: string): void {
    const lines: string[] = Text.convertToLf(line).split('\n');
    for (const realLine of lines) {
      writer.write('// ');
      writer.write(realLine);
      writer.writeLine();
    }
  }
}
