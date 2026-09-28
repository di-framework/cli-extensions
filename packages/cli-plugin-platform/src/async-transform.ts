import { type PluginObj, types as t, template } from '@babel/core';

/** Lower for-await loops before async-to-generator, retaining native generators. */
export function lowerForAwait(): PluginObj {
  return {
    visitor: {
      Program(program, state) {
        program.traverse({
          ForOfStatement(path) {
            if (!path.node.await) return;
            const iterator = path.scope.generateUidIdentifier('iterator');
            const step = path.scope.generateUidIdentifier('step');
            const abrupt = path.scope.generateUidIdentifier('abrupt');
            const failed = path.scope.generateUidIdentifier('failed');
            const error = path.scope.generateUidIdentifier('error');
            const caught = path.scope.generateUidIdentifier('caught');
            const { left, right, body } = path.node;
            const value = t.memberExpression(step, t.identifier('value'));
            const assignment = t.isVariableDeclaration(left)
              ? t.variableDeclaration(left.kind, [
                  t.variableDeclarator(left.declarations[0]!.id, value),
                ])
              : t.expressionStatement(t.assignmentExpression('=', left, value));
            const block = template.statement(
              `{
              var ITERATOR = HELPER(SOURCE), STEP, ABRUPT = false, FAILED = false, ERROR;
              try {
                for (; ABRUPT = !(STEP = await ITERATOR.next()).done; ABRUPT = false) {
                  ASSIGNMENT;
                  BODY;
                }
              } catch (CAUGHT) { FAILED = true; ERROR = CAUGHT; }
              finally {
                try { if (ABRUPT && ITERATOR.return != null) await ITERATOR.return(); }
                finally { if (FAILED) throw ERROR; }
              }
            }`,
              { allowAwaitOutsideFunction: true },
            )({
              ITERATOR: iterator,
              STEP: step,
              ABRUPT: abrupt,
              FAILED: failed,
              ERROR: error,
              CAUGHT: caught,
              HELPER: (
                state.file as typeof state.file & { addHelper(name: string): t.Identifier }
              ).addHelper('asyncIterator'),
              SOURCE: right,
              ASSIGNMENT: assignment,
              BODY: t.isBlockStatement(body) ? body.body : [body],
            }) as t.BlockStatement;
            if (path.parentPath.isLabeledStatement()) {
              const statement = block.body[1] as t.TryStatement;
              statement.block.body[0] = t.labeledStatement(
                path.parentPath.node.label,
                statement.block.body[0]!,
              );
              path.parentPath.replaceWith(block);
            } else path.replaceWith(block);
          },
        });
      },
    },
  };
}
