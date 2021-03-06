import { Rule, SchematicsException, Tree } from '@angular-devkit/schematics';
import { addSymbolToNgModuleMetadata, findNodes, getDecoratorMetadata, getSourceNodes, insertAfterLastOccurrence } from '@schematics/angular/utility/ast-utils';
import { Change, InsertChange, NoopChange, RemoveChange, ReplaceChange } from '@schematics/angular/utility/change';
import * as path from 'path';
import * as ts from 'typescript';
import { serializeJson } from './fileutils';
import { toFileName } from './name-utils';
/**
 * This method is specifically for updating in a Tree
 * @param localPath Path of file in the Tree
 * @param callback Manipulation of the data
 * @returns A rule which updates a file file in a Tree
 */
export function updateFileInTree(
  localPath: string,
  callback: (data: string, host?: Tree) => string
): Rule {
  return (host: Tree): Tree => {
    if (!host.exists(localPath)) {
      host.create(localPath, callback('', host));
      return host;
    }
    host.overwrite(localPath, callback(readFileInTree(host, localPath), host));
    return host;
  };
}

/**
 * This method is specifically for reading files in a Tree
 * @param host The host tree
 * @param localPath The path to the file
 * @returns The data in the file.
 */
export function readFileInTree(host: Tree, localPath: string): string {
  if (!host.exists(localPath)) {
    throw new Error(`Cannot find ${localPath}`);
  }
  const contents = host.read(localPath).toString('utf-8');
  try {
    return contents;
  } catch (e) {
    throw new Error(`Cannot parse ${localPath}: ${e.message}`);
  }
}

export function readIntoSourceFile(host: Tree, modulePath: string): ts.SourceFile {
  const text = host.read(modulePath);
  if (text === null) {
    throw new SchematicsException(`File ${modulePath} does not exist.`);
  }
  const sourceText = text.toString('utf-8');

  return ts.createSourceFile(modulePath, sourceText, ts.ScriptTarget.Latest, true);
}

export function deleteInTree<T = any, O = T>(
  localPath: string,
  isDirectory = false
): Rule {
  return (host: Tree): Tree => {
    if (isDirectory) {
      host.visit(file => {
        if (file.startsWith(localPath)) {
          host.delete(file);
        }
      });
    } else {
      if (host.exists(localPath)) {
        host.delete(localPath);
      }
    }
    return host;
  };
}

/////////////////////////////////

export function addReexport(
  source: ts.SourceFile,
  modulePath: string,
  reexportedFileName: string,
  token: string
): Change[] {
  const allExports = findNodes(source, ts.SyntaxKind.ExportDeclaration);
  if (allExports.length > 0) {
    const m = allExports.filter(
      (e: ts.ExportDeclaration) =>
        e.moduleSpecifier.getText(source).indexOf(reexportedFileName) > -1
    );
    if (m.length > 0) {
      const mm: ts.ExportDeclaration = <any>m[0];
      return [
        new InsertChange(modulePath, mm.exportClause.end - 1, `, ${token} `)
      ];
    }
  }
  return [];
}

export function addParameterToConstructor(
  source: ts.SourceFile,
  modulePath: string,
  opts: { className: string; param: string }
): Change[] {
  const clazz = findClass(source, opts.className);
  const constructor = clazz.members.filter(
    m => m.kind === ts.SyntaxKind.Constructor
  )[0];
  if (constructor) {
    throw new Error('Should be tested');
  } else {
    const methodHeader = `constructor(${opts.param})`;
    return addMethod(source, modulePath, {
      className: opts.className,
      methodHeader,
      body: null
    });
  }
}

export function addMethod(
  source: ts.SourceFile,
  modulePath: string,
  opts: { className: string; methodHeader: string; body: string }
): Change[] {
  const clazz = findClass(source, opts.className);
  const body = opts.body
    ? `
${opts.methodHeader} {
${offset(opts.body, 1, false)}
}
`
    : `
${opts.methodHeader} {}
`;

  return [new InsertChange(modulePath, clazz.end - 1, offset(body, 1, true))];
}

export function removeFromNgModule(
  source: ts.SourceFile,
  modulePath: string,
  property: string
): Change[] {
  const nodes = getDecoratorMetadata(source, 'NgModule', '@angular/core');
  const node: any = nodes[0]; // tslint:disable-line:no-any

  // Find the decorator declaration.
  if (!node) {
    return [];
  }

  // Get all the children property assignment of object literals.
  const matchingProperty = getMatchingProperty(
    source,
    property,
    'NgModule',
    '@angular/core'
  );
  if (matchingProperty) {
    return [
      new RemoveChange(
        modulePath,
        matchingProperty.getStart(source),
        matchingProperty.getFullText(source)
      )
    ];
  } else {
    return [];
  }
}

export function findClass(
  source: ts.SourceFile,
  className: string,
  silent: boolean = false
): ts.ClassDeclaration {
  const nodes = getSourceNodes(source);

  const clazz = <any>(
    nodes.filter(
      n =>
        n.kind === ts.SyntaxKind.ClassDeclaration &&
        (<any>n).name.text === className
    )[0]
  );

  if (!clazz && !silent) {
    throw new Error(`Cannot find class '${className}'`);
  }

  return clazz;
}

export function offset(
  text: string,
  numberOfTabs: number,
  wrap: boolean
): string {
  const lines = text
    .trim()
    .split('\n')
    .map(line => {
      let tabs = '';
      for (let c = 0; c < numberOfTabs; ++c) {
        tabs += '  ';
      }
      return `${tabs}${line}`;
    })
    .join('\n');

  return wrap ? `\n${lines}\n` : lines;
}

export function addImportToModule(
  source: ts.SourceFile,
  modulePath: string,
  symbolName: string
): Change[] {
  return addSymbolToNgModuleMetadata(
    source,
    modulePath,
    'imports',
    symbolName
  );
}

export function addImportToTestBed(
  source: ts.SourceFile,
  specPath: string,
  symbolName: string
): Change[] {
  const allCalls: ts.CallExpression[] = <any>(
    findNodes(source, ts.SyntaxKind.CallExpression)
  );

  const configureTestingModuleObjectLiterals = allCalls
    .filter(c => c.expression.kind === ts.SyntaxKind.PropertyAccessExpression)
    .filter(
      (c: any) => c.expression.name.getText(source) === 'configureTestingModule'
    )
    .map(c =>
      c.arguments[0].kind === ts.SyntaxKind.ObjectLiteralExpression
        ? c.arguments[0]
        : null
    );

  if (configureTestingModuleObjectLiterals.length > 0) {
    const startPosition = configureTestingModuleObjectLiterals[0]
      .getFirstToken(source)
      .getEnd();
    return [
      new InsertChange(specPath, startPosition, `imports: [${symbolName}], `)
    ];
  } else {
    return [];
  }
}

export function getBootstrapComponent(
  source: ts.SourceFile,
  moduleClassName: string
): string {
  const bootstrap = getMatchingProperty(
    source,
    'bootstrap',
    'NgModule',
    '@angular/core'
  );
  if (!bootstrap) {
    throw new Error(`Cannot find bootstrap components in '${moduleClassName}'`);
  }
  const c = bootstrap.getChildren();
  const nodes = c[c.length - 1].getChildren();

  const bootstrapComponent = nodes.slice(1, nodes.length - 1)[0];
  if (!bootstrapComponent) {
    throw new Error(`Cannot find bootstrap components in '${moduleClassName}'`);
  }

  return bootstrapComponent.getText();
}

function getMatchingObjectLiteralElement(
  node: any,
  source: ts.SourceFile,
  property: string
) {
  return (
    (node as ts.ObjectLiteralExpression).properties
      .filter(prop => prop.kind === ts.SyntaxKind.PropertyAssignment)
      // Filter out every fields that's not "metadataField". Also handles string literals
      // (but not expressions).
      .filter((prop: ts.PropertyAssignment) => {
        const name = prop.name;
        switch (name.kind) {
          case ts.SyntaxKind.Identifier:
            return (name as ts.Identifier).getText(source) === property;
          case ts.SyntaxKind.StringLiteral:
            return (name as ts.StringLiteral).text === property;
        }
        return false;
      })[0]
  );
}

function getMatchingProperty(
  source: ts.SourceFile,
  property: string,
  identifier: string,
  module: string
): ts.ObjectLiteralElement {
  const nodes = getDecoratorMetadata(source, identifier, module);
  const node: any = nodes[0]; // tslint:disable-line:no-any

  if (!node) return null;

  // Get all the children property assignment of object literals.
  return getMatchingObjectLiteralElement(node, source, property);
}

export function addRoute(
  ngModulePath: string,
  source: ts.SourceFile,
  route: string
): Change[] {
  const routes = getListOfRoutes(source);
  if (!routes) return [];

  if (routes.hasTrailingComma || routes.length === 0) {
    return [new InsertChange(ngModulePath, routes.end, route)];
  } else {
    return [new InsertChange(ngModulePath, routes.end, `, ${route}`)];
  }
}

export function addIncludeToTsConfig(
  tsConfigPath: string,
  source: ts.SourceFile,
  include: string
): Change[] {
  const includeKeywordPos = source.text.indexOf('"include":');
  if (includeKeywordPos > -1) {
    const includeArrayEndPos = source.text.indexOf(']', includeKeywordPos);
    return [new InsertChange(tsConfigPath, includeArrayEndPos, include)];
  } else {
    return [];
  }
}

function getListOfRoutes(source: ts.SourceFile): ts.NodeArray<ts.Expression> {
  const imports: any = getMatchingProperty(
    source,
    'imports',
    'NgModule',
    '@angular/core'
  );

  if (imports.initializer.kind === ts.SyntaxKind.ArrayLiteralExpression) {
    const a = imports.initializer as ts.ArrayLiteralExpression;

    for (const e of a.elements) {
      if (e.kind === ts.SyntaxKind.CallExpression) {
        const ee = e as ts.CallExpression;
        const text = ee.expression.getText(source);
        if (
          (text === 'RouterModule.forRoot' ||
            text === 'RouterModule.forChild') &&
          ee.arguments.length > 0
        ) {
          const routes = ee.arguments[0];
          if (routes.kind === ts.SyntaxKind.ArrayLiteralExpression) {
            return (routes as ts.ArrayLiteralExpression).elements;
          }
        }
      }
    }
  }
  return null;
}

export function getImport(
  source: ts.SourceFile,
  predicate: (a: any) => boolean
): { moduleSpec: string; bindings: string[] }[] {
  const allImports = findNodes(source, ts.SyntaxKind.ImportDeclaration);
  const matching = allImports.filter((i: ts.ImportDeclaration) =>
    predicate(i.moduleSpecifier.getText())
  );

  return matching.map((i: ts.ImportDeclaration) => {
    const moduleSpec = i.moduleSpecifier
      .getText()
      .substring(1, i.moduleSpecifier.getText().length - 1);
    const t = i.importClause.namedBindings.getText();
    const bindings = t
      .replace('{', '')
      .replace('}', '')
      .split(',')
      .map(q => q.trim());
    return { moduleSpec, bindings };
  });
}

export function addProviderToModule(
  source: ts.SourceFile,
  modulePath: string,
  symbolName: string
): Change[] {
  return addSymbolToNgModuleMetadata(
    source,
    modulePath,
    'providers',
    symbolName
  );
}

export function addDeclarationToModule(
  source: ts.SourceFile,
  modulePath: string,
  symbolName: string
): Change[] {
  return addSymbolToNgModuleMetadata(
    source,
    modulePath,
    'declarations',
    symbolName
  );
}

export function addEntryComponents(
  source: ts.SourceFile,
  modulePath: string,
  symbolName: string
): Change[] {
  return addSymbolToNgModuleMetadata(
    source,
    modulePath,
    'entryComponents',
    symbolName
  );
}

export function addGlobal(
  source: ts.SourceFile,
  modulePath: string,
  statement: string
): Change[] {
  const allImports = findNodes(source, ts.SyntaxKind.ImportDeclaration);
  if (allImports.length > 0) {
    const lastImport = allImports[allImports.length - 1];
    return [
      new InsertChange(modulePath, lastImport.end + 1, `\n${statement}\n`)
    ];
  } else {
    return [new InsertChange(modulePath, 0, `${statement}\n`)];
  }
}

export function insert(host: Tree, modulePath: string, changes: Change[]) {
  if (changes.length < 1) {
    return;
  }
  const recorder = host.beginUpdate(modulePath);
  for (const change of changes) {
    if (change instanceof InsertChange) {
      recorder.insertLeft(change.pos, change.toAdd);
    } else if (change instanceof RemoveChange) {
      recorder.remove((<any>change).pos - 1, (<any>change).toRemove.length + 1);
    } else if (change instanceof NoopChange) {
      // do nothing
    } else if (change instanceof ReplaceChange) {
      const action = <any>change;
      recorder.remove(action.pos, action.oldText.length);
      recorder.insertLeft(action.pos, action.newText);
    } else {
      throw new Error(`Unexpected Change '${change}'`);
    }
  }
  host.commitUpdate(recorder);
}

/**
 * This method is specifically for reading JSON files in a Tree
 * @param host The host tree
 * @param localPath The path to the JSON file
 * @returns The JSON data in the file.
 */
export function readJsonInTree<T = any>(host: Tree, localPath: string): T {
  if (!host.exists(localPath)) {
    throw new Error(`Cannot find ${localPath}`);
  }
  const contents = host.read(localPath).toString('utf-8');
  try {
    return JSON.parse(contents);
  } catch (e) {
    throw new Error(`Cannot parse ${localPath}: ${e.message}`);
  }
}

/**
 * This method is specifically for updating JSON in a Tree
 * @param localPath Path of JSON file in the Tree
 * @param callback Manipulation of the JSON data
 * @returns A rule which updates a JSON file file in a Tree
 */
export function updateJsonInTree<T = any, O = T>(
  localPath: string,
  callback: (json: T) => O
): Rule {
  return (host: Tree): Tree => {
    if (!host.exists(localPath)) {
      host.create(localPath, serializeJson(callback({} as T)));
      return host;
    }
    host.overwrite(
      localPath,
      serializeJson(callback(readJsonInTree(host, localPath)))
    );
    return host;
  };
}

export function getProjectConfig(host: Tree, name: string): any {
  const angularJson = readJsonInTree(host, '/angular.json');
  const projectConfig = angularJson.projects[name];
  if (!projectConfig) {
    throw new Error(`Cannot find project '${name}'`);
  } else {
    return projectConfig;
  }
}

export function updateProjectConfig(name: string, projectConfig: any): Rule {
  return updateJsonInTree('/angular.json', angularJson => {
    angularJson.projects[name] = projectConfig;
    return angularJson;
  });
}

export function readBootstrapInfo(
  host: Tree,
  app: string
): {
  moduleSpec: string;
  modulePath: string;
  mainPath: string;
  moduleClassName: string;
  moduleSource: ts.SourceFile;
  bootstrapComponentClassName: string;
  bootstrapComponentFileName: string;
} {
  const config = getProjectConfig(host, app);

  let mainPath;
  try {
    mainPath = config.architect.build.options.main;
  } catch (e) {
    throw new Error('Main file cannot be located');
  }

  if (!host.exists(mainPath)) {
    throw new Error('Main file cannot be located');
  }

  const mainSource = host.read(mainPath).toString('utf-8');
  const main = ts.createSourceFile(
    mainPath,
    mainSource,
    ts.ScriptTarget.Latest,
    true
  );
  const moduleImports = getImport(
    main,
    (s: string) => s.indexOf('.module') > -1
  );
  if (moduleImports.length !== 1) {
    throw new Error(`main.ts can only import a single module`);
  }
  const moduleImport = moduleImports[0];
  const moduleClassName = moduleImport.bindings.filter(b =>
    b.endsWith('Module')
  )[0];

  const modulePath = `${path.join(
    path.dirname(mainPath),
    moduleImport.moduleSpec
  )}.ts`;
  if (!host.exists(modulePath)) {
    throw new Error(`Cannot find '${modulePath}'`);
  }

  const moduleSourceText = host.read(modulePath).toString('utf-8');
  const moduleSource = ts.createSourceFile(
    modulePath,
    moduleSourceText,
    ts.ScriptTarget.Latest,
    true
  );

  const bootstrapComponentClassName = getBootstrapComponent(
    moduleSource,
    moduleClassName
  );
  const bootstrapComponentFileName = `./${path.join(
    path.dirname(moduleImport.moduleSpec),
    `${toFileName(
      bootstrapComponentClassName.substring(
        0,
        bootstrapComponentClassName.length - 9
      )
    )}.component`
  )}`;

  return {
    moduleSpec: moduleImport.moduleSpec,
    mainPath,
    modulePath,
    moduleSource,
    moduleClassName,
    bootstrapComponentClassName,
    bootstrapComponentFileName
  };
}

export function addClass(
  source: ts.SourceFile,
  modulePath: string,
  clazzName: string,
  clazzSrc: string
): Change {
  if (!findClass(source, clazzName, true)) {
    const nodes = findNodes(source, ts.SyntaxKind.ClassDeclaration);
    return insertAfterLastOccurrence(
      nodes,
      offset(clazzSrc, 0, true),
      modulePath,
      0,
      ts.SyntaxKind.ClassDeclaration
    );
  }
  return new NoopChange();
}

/**
 * e.g
 * ```ts
 *   export type <Feature>Actions = <Feature> | Load<Feature>s | <Feature>sLoaded | <Feature>sLoadError;
 * ```
 */
export function addUnionTypes(
  source: ts.SourceFile,
  modulePath: string,
  typeName: string,
  typeValues: string[]
) {
  const target: ts.TypeAliasDeclaration = findNodesOfType(
    source,
    ts.SyntaxKind.TypeAliasDeclaration,
    it => it.name.getText() === typeName
  );
  if (!target) {
    throw new Error(`Cannot find union type '${typeName}'`);
  }

  const node = target.type as ts.TypeReferenceNode;

  // Append new types to create a union type...
  return new InsertChange(
    modulePath,
    node.end,
    ['', ...typeValues].join(' | ')
  );
}

/**
 * Add 1..n enumerators using name + (optional) value pairs
 */
export function addEnumeratorValues(
  source: ts.SourceFile,
  modulePath: string,
  enumName: string,
  pairs: NameValue[] = []
): Change[] {
  const target = findNodesOfType(
    source,
    ts.SyntaxKind.EnumDeclaration,
    it => it.name.getText() === enumName
  );
  const list = target ? target.members : undefined;
  if (!target) {
    throw new Error(`Cannot find enum '${enumName}'`);
  }
  const addComma = !(list.hasTrailingComma || list.length === 0);

  return pairs.reduce((buffer, it) => {
    const member = it.value ? `${it.name} = '${it.value}'` : it.name;
    const memberExists = () => {
      return list.filter(m => m.name.getText() === it.name).length;
    };

    if (memberExists()) {
      throw new Error(`Enum '${enumName}.${it.name}' already exists`);
    }

    return [
      ...buffer,
      new InsertChange(modulePath, list.end, (addComma ? ', ' : '') + member)
    ];
  }, []);
}

/**
 * Find Enum declaration in source based on name
 * e.g.
 *    export enum ProductsActionTypes {
 *       ProductsAction = '[Products] Action'
 *    }
 */
const IDENTITY = a => a;
export function findNodesOfType(
  source: ts.Node,
  kind: ts.SyntaxKind,
  predicate: (a: any) => boolean,
  extract: (a: any) => any = IDENTITY,
  firstOnly: boolean = true
): any {
  const nodes = findNodes(source, kind);
  const matching = nodes.filter((i: any) => predicate(i)).map(extract);
  return matching.length ? (firstOnly ? matching[0] : matching) : undefined;
}

export interface NameValue {
  name: string;
  value?: string;
}

export function createOrUpdate(host: Tree, localPath: string, content: string) {
  if (host.exists(localPath)) {
    host.overwrite(localPath, content);
  } else {
    host.create(localPath, content);
  }
}

export function insertImport(
  source: ts.SourceFile,
  fileToEdit: string,
  symbolName: string,
  fileName: string,
  isDefault = false
): Change {
  const rootNode = source;
  const allImports = findNodes(rootNode, ts.SyntaxKind.ImportDeclaration);

  // get nodes that map to import statements from the file fileName
  const relevantImports = allImports.filter(node => {
    // StringLiteral of the ImportDeclaration is the import file (fileName in this case).
    const importFiles = node
      .getChildren()
      .filter(child => child.kind === ts.SyntaxKind.StringLiteral)
      .map(n => (n as ts.StringLiteral).text);

    return importFiles.filter(file => file === fileName).length === 1;
  });

  if (relevantImports.length > 0) {
    let importsAsterisk = false;
    // imports from import file
    const imports: ts.Node[] = [];
    relevantImports.forEach(n => {
      Array.prototype.push.apply(
        imports,
        findNodes(n, ts.SyntaxKind.Identifier)
      );
      if (findNodes(n, ts.SyntaxKind.AsteriskToken).length > 0) {
        importsAsterisk = true;
      }
    });

    // if imports * from fileName, don't add symbolName
    if (importsAsterisk) {
      return new NoopChange();
    }

    const importTextNodes = imports.filter(
      n => (n as ts.Identifier).text === symbolName
    );

    // insert import if it's not there
    if (importTextNodes.length === 0) {
      const _fallbackPos =
        findNodes(
          relevantImports[0],
          ts.SyntaxKind.CloseBraceToken
        )[0].getStart() ||
        findNodes(relevantImports[0], ts.SyntaxKind.FromKeyword)[0].getStart();

      return insertAfterLastOccurrence(
        imports,
        `, ${symbolName}`,
        fileToEdit,
        _fallbackPos
      );
    }

    return new NoopChange();
  }

  // no such import declaration exists
  const useStrict = findNodes(rootNode, ts.SyntaxKind.StringLiteral).filter(
    (n: ts.StringLiteral) => n.text === 'use strict'
  );
  let fallbackPos = 0;
  if (useStrict.length > 0) {
    fallbackPos = useStrict[0].end;
  }
  const open = isDefault ? '' : '{ ';
  const close = isDefault ? '' : ' }';
  // if there are no imports or 'use strict' statement, insert import at beginning of file
  const insertAtBeginning = allImports.length === 0 && useStrict.length === 0;
  const separator = insertAtBeginning ? '' : ';\n';
  const toInsert =
    `${separator}import ${open}${symbolName}${close}` +
    ` from '${fileName}'${insertAtBeginning ? ';\n' : ''}`;

  return insertAfterLastOccurrence(
    allImports,
    toInsert,
    fileToEdit,
    fallbackPos,
    ts.SyntaxKind.StringLiteral
  );
}

export function getDecoratorPropertyValueNode(
  localHost: Tree,
  modulePath: string,
  identifier: string,
  property: string,
  module: string
) {
  const moduleSourceText = localHost.read(modulePath).toString('utf-8');
  const moduleSource = ts.createSourceFile(
    modulePath,
    moduleSourceText,
    ts.ScriptTarget.Latest,
    true
  );
  const templateNode = getMatchingProperty(
    moduleSource,
    property,
    identifier,
    module
  );

  return templateNode.getChildAt(templateNode.getChildCount() - 1);
}

export function replaceNodeValue(
  host: Tree,
  modulePath: string,
  node: ts.Node,
  content: string
) {
  insert(host, modulePath, [
    new ReplaceChange(
      modulePath,
      node.getStart(node.getSourceFile()),
      node.getFullText(),
      content
    )
  ]);
}
