import path from 'path';
import ts from 'typescript';
import { executeCodegen } from '@graphql-codegen/cli';
import { preset } from '../src/index.js';

/**
 * Type-level verification for fragment masking of conditional (@include/@skip)
 * fragment spreads. Snapshots alone cannot catch overload-resolution mistakes,
 * so this suite compiles the generated output together with realistic usage
 * code and asserts that the TypeScript compiler accepts it.
 */

const compilerOptions: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

// virtual files are addressed inside the (existing) tests directory so that
// module resolution can probe the directory and walk node_modules upwards for
// '@graphql-typed-document-node/core' and 'graphql'
const virtualDir = __dirname;

function compile(files: Record<string, string>): string[] {
  const virtualFiles = new Map(
    Object.entries(files).map(([name, content]) => [path.join(virtualDir, name), content]),
  );

  const host = ts.createCompilerHost(compilerOptions);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.fileExists = fileName => virtualFiles.has(fileName) || originalFileExists(fileName);
  host.readFile = fileName => virtualFiles.get(fileName) ?? originalReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const virtual = virtualFiles.get(fileName);
    if (virtual !== undefined) {
      return ts.createSourceFile(fileName, virtual, languageVersion);
    }
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };

  const program = ts.createProgram([...virtualFiles.keys()], compilerOptions, host);

  return ts.getPreEmitDiagnostics(program).map(diagnostic => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (diagnostic.file && diagnostic.start !== undefined) {
      const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return `${path.basename(diagnostic.file.fileName)}:${line + 1} - ${message}`;
    }
    return message;
  });
}

describe('fragment masking with conditional fragment spreads (type-level)', () => {
  it('generated types and helpers compile with realistic usage code', async () => {
    const { result } = await executeCodegen({
      schema: /* GraphQL */ `
        type Query {
          user: User
        }

        type User {
          id: ID!
          nicknames: [String!]
        }
      `,
      documents: /* GraphQL */ `
        query GetUser($withNicknames: Boolean!) {
          user {
            id
            ...UserNicknames @include(if: $withNicknames)
          }
        }

        fragment UserNicknames on User {
          nicknames
        }
      `,
      generates: {
        'out1/': {
          preset,
        },
      },
    });

    const graphqlFile = result.find(file => file.filename === 'out1/graphql.ts');
    const fragmentMaskingFile = result.find(file => file.filename === 'out1/fragment-masking.ts');

    const usage = /* TypeScript */ `
      import { FragmentType, OptionalFragmentType, useFragment } from './fragment-masking';
      import {
        UserNicknamesFragment,
        UserNicknamesFragmentDoc,
        GetUserQuery,
      } from './graphql';

      type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;
      type Expect<T extends true> = T;

      declare const query: GetUserQuery;
      const user = query.user!;

      // a conditional fragment ref is assignable to OptionalFragmentType (component prop pattern)
      const optionalRef: OptionalFragmentType<typeof UserNicknamesFragmentDoc> = user;

      // @ts-expect-error the fragment may be absent at runtime, so the ref must not satisfy FragmentType
      const requiredRef: FragmentType<typeof UserNicknamesFragmentDoc> = user;

      // unmasking an optional ref yields TType | undefined
      const data = useFragment(UserNicknamesFragmentDoc, optionalRef);
      type _data = Expect<Equal<typeof data, UserNicknamesFragment | undefined>>;

      // passing the query result field directly behaves the same
      const dataDirect = useFragment(UserNicknamesFragmentDoc, user);
      type _dataDirect = Expect<Equal<typeof dataDirect, UserNicknamesFragment | undefined>>;

      // a required (unconditional) ref still unmasks to TType via the existing overloads
      declare const required: FragmentType<typeof UserNicknamesFragmentDoc>;
      const dataRequired = useFragment(UserNicknamesFragmentDoc, required);
      type _dataRequired = Expect<Equal<typeof dataRequired, UserNicknamesFragment>>;

      // required refs remain assignable to the optional helper,
      // so components typed with OptionalFragmentType accept both kinds of parents
      const widened: OptionalFragmentType<typeof UserNicknamesFragmentDoc> = required;

      // nullable variants
      declare const optionalOrNull:
        | OptionalFragmentType<typeof UserNicknamesFragmentDoc>
        | null
        | undefined;
      const dataOrNull = useFragment(UserNicknamesFragmentDoc, optionalOrNull);
      type _dataOrNull = Expect<
        Equal<typeof dataOrNull, UserNicknamesFragment | null | undefined>
      >;

      // list variants unmask element-wise
      declare const optionalList: Array<OptionalFragmentType<typeof UserNicknamesFragmentDoc>>;
      const dataList = useFragment(UserNicknamesFragmentDoc, optionalList);
      type _dataList = Expect<Equal<typeof dataList, Array<UserNicknamesFragment | undefined>>>;

      export { optionalRef, requiredRef, data, dataDirect, dataRequired, widened, dataOrNull, dataList };
    `;

    const diagnostics = compile({
      'graphql.ts': graphqlFile.content,
      'fragment-masking.ts': fragmentMaskingFile.content,
      'usage.ts': usage,
    });

    expect(diagnostics).toEqual([]);
  });
});
