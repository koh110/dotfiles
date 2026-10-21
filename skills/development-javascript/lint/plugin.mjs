import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
])

const LOOP_TYPES = new Set([
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
])

function isRelativeSpecifier(value) {
  return value === '.' || value === '..' || value.startsWith('./') || value.startsWith('../')
}

function getStringValue(node) {
  if (node && node.type === 'Literal' && typeof node.value === 'string') {
    return node.value
  }
  return null
}

function createModuleSourceVisitor(check) {
  return {
    ImportDeclaration(node) {
      check(node.source)
    },
    ExportNamedDeclaration(node) {
      if (node.source) {
        check(node.source)
      }
    },
    ExportAllDeclaration(node) {
      check(node.source)
    },
    ImportExpression(node) {
      check(node.source)
    },
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
        check(node.arguments[0])
      }
    },
  }
}

const noClass = {
  meta: {
    type: 'problem',
    docs: {
      description: 'classを禁止し、関数とオブジェクトリテラルのモジュールパターンを使わせる',
    },
  },
  create(context) {
    function report(node) {
      context.report({
        node,
        message:
          'classを利用しない。関数とオブジェクトリテラルを組み合わせたモジュールパターンを使う',
      })
    }
    return {
      ClassDeclaration: report,
      ClassExpression: report,
    }
  },
}

const noAliasImport = {
  meta: {
    type: 'problem',
    docs: { description: 'path alias(@/, ~/, #, 絶対path)によるimportを禁止する' },
  },
  create(context) {
    return createModuleSourceVisitor((source) => {
      const value = getStringValue(source)
      if (value === null || !/^(?:[@~]\/|#|\/)/.test(value)) {
        return
      }
      context.report({
        node: source,
        message: `'${value}' はaliasによるimport。相対パスでimportする`,
      })
    })
  },
}

const noIndexOmit = {
  meta: {
    type: 'problem',
    docs: { description: 'directoryを指すimportでindexを省略することを禁止する' },
  },
  create(context) {
    const baseDir = dirname(context.filename)
    return createModuleSourceVisitor((source) => {
      const value = getStringValue(source)
      if (value === null || !isRelativeSpecifier(value)) {
        return
      }
      const lastSegment = value.split('/').at(-1)
      const target = resolve(baseDir, value)
      if (
        lastSegment === '' ||
        lastSegment === '.' ||
        lastSegment === '..' ||
        (existsSync(target) && statSync(target).isDirectory())
      ) {
        context.report({
          node: source,
          message: `'${value}' はdirectoryを指している。indexを省略せずファイルまで指定する`,
        })
      }
    })
  },
}

const noExplicitReturnType = {
  meta: {
    type: 'suggestion',
    docs: { description: '関数の返り値の型注釈を禁止し推論に任せる(type predicateは除く)' },
  },
  create(context) {
    function check(node) {
      if (!node.returnType) {
        return
      }
      if (node.returnType.typeAnnotation.type === 'TSTypePredicate') {
        return
      }
      context.report({
        node: node.returnType,
        message: '関数の返り値の型を指定しない。推論に任せる',
      })
    }
    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    }
  },
}

const noFilterTypePredicate = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Array.prototype.filterのcallbackでtype predicate(is)を使わない' },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        if (
          callee.type !== 'MemberExpression' ||
          callee.computed ||
          callee.property.type !== 'Identifier' ||
          callee.property.name !== 'filter'
        ) {
          return
        }
        const callback = node.arguments[0]
        if (
          callback &&
          FUNCTION_TYPES.has(callback.type) &&
          callback.returnType &&
          callback.returnType.typeAnnotation.type === 'TSTypePredicate'
        ) {
          context.report({
            node: callback.returnType,
            message: 'filterでは `is` を使わず型推論に任せる',
          })
        }
      },
    }
  },
}

function crossesScopeOrLoop(identifier, block) {
  let current = identifier.parent
  while (current && current !== block) {
    if (FUNCTION_TYPES.has(current.type) || LOOP_TYPES.has(current.type)) {
      return true
    }
    current = current.parent
  }
  return current !== block
}

const noSingleUseVariable = {
  meta: {
    type: 'suggestion',
    docs: { description: '参照が1つしかないconst変数を不必要に作らない' },
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (node.kind !== 'const') {
          return
        }
        // module直下の名前付き定数は対象外にし、関数内の一時変数だけを見る
        const block = node.parent
        if (block.type !== 'BlockStatement') {
          return
        }
        for (const declarator of node.declarations) {
          if (
            declarator.id.type !== 'Identifier' ||
            !declarator.init ||
            FUNCTION_TYPES.has(declarator.init.type) ||
            declarator.init.type === 'ClassExpression'
          ) {
            continue
          }
          for (const variable of context.sourceCode.getDeclaredVariables(declarator)) {
            const reads = variable.references.filter((reference) => {
              return reference.isRead()
            })
            if (reads.length !== 1) {
              continue
            }
            const identifier = reads[0].identifier
            if (
              identifier.parent.type === 'ExportSpecifier' ||
              crossesScopeOrLoop(identifier, block)
            ) {
              continue
            }
            context.report({
              node: declarator.id,
              message: `'${variable.name}' は参照が1つだけ。不必要な変数化を避けて参照箇所に直接書けないか検討する`,
            })
          }
        }
      },
    }
  },
}

const noModuleMock = {
  meta: {
    type: 'problem',
    docs: { description: 'グローバルsetupファイルでのmodule mockを禁止する' },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.object.type === 'Identifier' &&
          (callee.object.name === 'vi' || callee.object.name === 'jest') &&
          callee.property.type === 'Identifier' &&
          (callee.property.name === 'mock' || callee.property.name === 'doMock')
        ) {
          context.report({
            node,
            message:
              'グローバルsetupでmoduleをmockしない。mockが必要なテストファイルで局所的に記述する',
          })
        }
      },
    }
  },
}

export default {
  meta: { name: 'js-skill' },
  rules: {
    'no-class': noClass,
    'no-alias-import': noAliasImport,
    'no-index-omit': noIndexOmit,
    'no-explicit-return-type': noExplicitReturnType,
    'no-filter-type-predicate': noFilterTypePredicate,
    'no-single-use-variable': noSingleUseVariable,
    'no-module-mock': noModuleMock,
  },
}
