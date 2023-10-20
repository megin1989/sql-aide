import { frontmatter as fm, ulid } from "./deps.ts";
import * as si from "../../lib/universal/sys-info.ts";
import * as ft from "../../lib/universal/flexible-text.ts";
import * as nb from "../../lib/notebook/mod.ts";
import * as SQLa from "../../render/mod.ts";
import * as m from "./models.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// TODO: move this to README.md and put these explanations in JSDoc
// ServiceContentHelpers creates "insertable" type-safe content objects needed by the other notebooks
// SqlNotebookHelpers encapsulates instances of SQLa objects needed to creation of SQL text in the other notebooks
// ConstructionSqlNotebook encapsulates DDL and table/view/entity construction
// MutationSqlNotebook encapsulates DML and stateful table data insert/update/delete
// QuerySqlNotebook encapsulates DQL and stateless table queries that can operate all within SQLite
// PolyglotSqlNotebook encapsulates SQL needed as part of multi-language (e.g. SQLite + Deno) orchestration because SQLite could not operate on its own
// SQLPageNotebook encapsulates [SQLPage](https://sql.ophir.dev/) content
// SqlNotebooksOrchestrator encapsulates instances of all the other notebooks and provides performs all the work

// Reminders:
// - when sending arbitrary text to the SQL stream, use SqlTextBehaviorSupplier
// - when sending SQL statements (which need to be ; terminated) use SqlTextSupplier

/**
 * Decorate a function with `@notIdempotent` if it's important to indicate
 * whether its SQL is idempotent or not. By default we assume all SQL is
 * idempotent but this can be set to indicate it's not.
 */
export const notIdempotent = <Notebook>(
  cells: Set<nb.NotebookShapeCell<Notebook>>,
) => {
  return (
    _target: SQLa.SqlNotebook<Any>,
    propertyKey: nb.NotebookShapeCell<Notebook>,
    _descriptor: PropertyDescriptor,
  ) => {
    cells.add(propertyKey);
  };
};

/**
 * Decorate a function with `@dontStoreInDB` if the particular query should
 * not be stored in the stored_notebook_cell table in the database.
 */
export const dontStoreInDB = <Notebook>(
  cells: Set<nb.NotebookShapeCell<Notebook>>,
) => {
  return (
    _target: SQLa.SqlNotebook<Any>,
    propertyKey: nb.NotebookShapeCell<Notebook>,
    _descriptor: PropertyDescriptor,
  ) => {
    cells.add(propertyKey);
  };
};

export const noSqliteExtnLoader: (
  extn: string,
) => SQLa.SqlTextBehaviorSupplier<Any> = (extn: string) => ({
  executeSqlBehavior: () => ({
    SQL: () => `-- loadExtnSQL not provided to load '${extn}'`,
  }),
});

export class ServiceContentHelpers<
  EmitContext extends SQLa.SqlEmitContext = SQLa.SqlEmitContext,
> {
  constructor(
    readonly models: ReturnType<typeof m.serviceModels<EmitContext>>,
  ) {}

  activeDevice(boundary?: string) {
    return {
      name: Deno.hostname(),
      boundary: boundary ?? "??",
    };
  }

  async activeDeviceInsertable(deviceId = { SQL: () => "ulid()" }) {
    const ad = this.activeDevice();
    return this.models.device.prepareInsertable({
      deviceId,
      name: ad.name,
      boundary: ad.boundary,
      deviceElaboration: JSON.stringify({
        hostname: Deno.hostname(),
        networkInterfaces: Deno.networkInterfaces(),
        osPlatformName: si.osPlatformName(),
        osArchitecture: await si.osArchitecture(),
      }),
    });
  }
}

export class SqlNotebookHelpers<
  EmitContext extends SQLa.SqlEmitContext = SQLa.SqlEmitContext,
> extends SQLa.SqlNotebook<EmitContext> {
  readonly sch: ServiceContentHelpers<EmitContext>;
  readonly models: ReturnType<typeof m.serviceModels<EmitContext>>;
  readonly loadExtnSQL: (
    extn: string,
  ) => SQLa.SqlTextBehaviorSupplier<EmitContext>;
  readonly stsOptions: SQLa.SqlTextSupplierOptions<EmitContext>;
  readonly execDbQueryResult: <Shape>(
    sqlSupplier: ft.FlexibleTextSupplierSync,
    sqliteDb?: string,
  ) => Promise<Shape[] | undefined>;
  readonly templateState: ReturnType<
    typeof m.serviceModels<EmitContext>
  >["universal"]["modelsGovn"]["templateState"];

  constructor(
    readonly options?: {
      readonly loadExtnSQL?: (
        extn: string,
      ) => SQLa.SqlTextBehaviorSupplier<EmitContext>;
      readonly models?: ReturnType<typeof m.serviceModels<EmitContext>>;
      readonly stsOptions?: SQLa.SqlTextSupplierOptions<EmitContext>;
      readonly execDbQueryResult?: <Shape>(
        sqlSupplier: ft.FlexibleTextSupplierSync,
        sqliteDb?: string,
      ) => Promise<Shape[] | undefined>;
    },
  ) {
    super();
    this.models = options?.models ?? m.serviceModels<EmitContext>();
    this.sch = new ServiceContentHelpers(this.models);
    this.templateState = this.models.universal.modelsGovn.templateState;
    this.loadExtnSQL = options?.loadExtnSQL ?? noSqliteExtnLoader;
    this.stsOptions = options?.stsOptions ??
      SQLa.typicalSqlTextSupplierOptions();
    this.execDbQueryResult = options?.execDbQueryResult ?? (() => {
      throw Error(`this.execDbQueryResult not supplied`);
    });
  }

  // type-safe wrapper for all SQL text generated in this library;
  // we call it `SQL` so that VS code extensions like frigus02.vscode-sql-tagged-template-literals
  // properly syntax-highlight code inside SQL`xyz` strings.
  get SQL() {
    return SQLa.SQL<EmitContext>(this.templateState.ddlOptions);
  }

  // type-safe wrapper for all SQL that should not be treated as SQL statements
  // but as arbitrary text to send to the SQL stream
  sqlBehavior(
    sts: SQLa.SqlTextSupplier<EmitContext>,
  ): SQLa.SqlTextBehaviorSupplier<EmitContext> {
    return {
      executeSqlBehavior: () => sts,
    };
  }

  // ULID generator when the value is needed in JS runtime
  get newUlid() {
    return ulid.ulid;
  }

  // ULID generator when the value is needed by the SQLite engine runtime
  get sqlEngineNewUlid(): SQLa.SqlTextSupplier<EmitContext> {
    return { SQL: () => `ulid()` };
  }

  get onConflictDoNothing(): SQLa.SqlTextSupplier<EmitContext> {
    return { SQL: () => `ON CONFLICT DO NOTHING` };
  }

  // See [SQLite Pragma Cheatsheet for Performance and Consistency](https://cj.rs/blog/sqlite-pragma-cheatsheet-for-performance-and-consistency/)
  get optimalOpenDB() {
    return this.sqlBehavior(this.SQL`
      -- make sure all pragmas are silent in case SQL will be piped
      .output /dev/null
      PRAGMA journal_mode = wal; -- different implementation of the atomicity properties
      PRAGMA synchronous = normal; -- synchronise less often to the filesystem
      PRAGMA foreign_keys = on; -- check foreign key reference, slightly worst performance
      .output stdout`);
  }

  get optimalCloseDB() {
    return this.sqlBehavior(this.SQL`
      -- make sure all pragmas are silent in case SQL will be piped
      .output /dev/null
      PRAGMA analysis_limit=400; -- make sure pragma optimize does not take too long
      PRAGMA optimize; -- gather statistics to improve query optimization
      .output stdout`);
  }

  viewDefn<ViewName extends string, DomainQS extends SQLa.SqlDomainQS>(
    viewName: ViewName,
  ) {
    return SQLa.viewDefinition<ViewName, EmitContext, DomainQS>(viewName, {
      isIdempotent: true,
      embeddedStsOptions: this.templateState.ddlOptions,
    });
  }
}

export class ConstructionSqlNotebook<
  EmitContext extends SQLa.SqlEmitContext = SQLa.SqlEmitContext,
> extends SQLa.SqlNotebook<EmitContext> {
  static identity = this.constructor.name;
  static readonly notIdempodentCells = new Set<keyof ConstructionSqlNotebook>();

  constructor(
    readonly nbh: SqlNotebookHelpers<EmitContext>,
    readonly existingMigrations: ReturnType<
      typeof nbh.models.universal.infoSchemaLifecycle.select
    >["filterable"][],
  ) {
    super();
  }

  @notIdempotent(ConstructionSqlNotebook.notIdempodentCells)
  initialDDL() {
    const { nbh, nbh: { models } } = this;
    // deno-fmt-ignore
    return nbh.SQL`
      ${nbh.optimalOpenDB}

      ${nbh.loadExtnSQL('asg017/ulid/ulid0')}

      ${models.universal.informationSchema.tables}

      ${models.universal.informationSchema.tableIndexes}

      ${models.informationSchema.tables}

      ${models.informationSchema.tableIndexes}

      ${models.universal.sqlPageFiles}

      ${nbh.optimalCloseDB}
      `;
  }

  fsContentWalkSessionStatsViewDDL() {
    // deno-fmt-ignore
    return this.nbh.viewDefn("fs_content_walk_session_stats")/* sql */`
      WITH Summary AS (
          SELECT
              strftime('%Y-%m-%d %H:%M:%S.%f', fcws.walk_started_at) AS walk_datetime,
              strftime('%f', fcws.walk_finished_at - fcws.walk_started_at) AS walk_duration,
              COALESCE(fcwpe.file_extn, '') AS file_extn,
              fcwp.root_path AS root_path,
              COUNT(fcwpe.fs_content_id) AS total_count,
              SUM(CASE WHEN fsc.frontmatter IS NOT NULL THEN 1 ELSE 0 END) AS with_frontmatter,
              AVG(fsc.file_bytes) AS average_size,
              strftime('%Y-%m-%d %H:%M:%S', datetime(MIN(fsc.file_mtime), 'unixepoch')) AS oldest,
              strftime('%Y-%m-%d %H:%M:%S', datetime(MAX(fsc.file_mtime), 'unixepoch')) AS youngest
          FROM
              fs_content_walk_session AS fcws
          LEFT JOIN
              fs_content_walk_path AS fcwp ON fcws.fs_content_walk_session_id = fcwp.walk_session_id
          LEFT JOIN
              fs_content_walk_path_entry AS fcwpe ON fcwp.fs_content_walk_path_id = fcwpe.walk_path_id
          LEFT JOIN
              fs_content AS fsc ON fcwpe.fs_content_id = fsc.fs_content_id
          GROUP BY
              fcws.walk_started_at,
              fcws.walk_finished_at,
              fcwpe.file_extn,
              fcwp.root_path
          UNION ALL
          SELECT
              strftime('%Y-%m-%d %H:%M:%S.%f', fcws.walk_started_at) AS walk_datetime,
              strftime('%f', fcws.walk_finished_at - fcws.walk_started_at) AS walk_duration,
              'ALL' AS file_extn,
              fcwp.root_path AS root_path,
              COUNT(fcwpe.fs_content_id) AS total_count,
              SUM(CASE WHEN fsc.frontmatter IS NOT NULL THEN 1 ELSE 0 END) AS with_frontmatter,
              AVG(fsc.file_bytes) AS average_size,
              strftime('%Y-%m-%d %H:%M:%S', datetime(MIN(fsc.file_mtime), 'unixepoch')) AS oldest,
              strftime('%Y-%m-%d %H:%M:%S', datetime(MAX(fsc.file_mtime), 'unixepoch')) AS youngest
          FROM
              fs_content_walk_session AS fcws
          LEFT JOIN
              fs_content_walk_path AS fcwp ON fcws.fs_content_walk_session_id = fcwp.walk_session_id
          LEFT JOIN
              fs_content_walk_path_entry AS fcwpe ON fcwp.fs_content_walk_path_id = fcwpe.walk_path_id
          LEFT JOIN
              fs_content AS fsc ON fcwpe.fs_content_id = fsc.fs_content_id
          GROUP BY
              fcws.walk_started_at,
              fcws.walk_finished_at,
              fcwp.root_path
      )
      SELECT
          walk_datetime,
          walk_duration,
          file_extn,
          root_path,
          total_count,
          with_frontmatter,
          CAST(ROUND(average_size) AS INTEGER) AS average_size,
          oldest,
          youngest
      FROM
          Summary
      ORDER BY
          walk_datetime,
          file_extn`;
  }
}

export class MutationSqlNotebook<
  EmitContext extends SQLa.SqlEmitContext = SQLa.SqlEmitContext,
> extends SQLa.SqlNotebook<EmitContext> {
  static identity = this.constructor.name;

  constructor(readonly nbh: SqlNotebookHelpers<EmitContext>) {
    super();
  }

  mimeTypesSeedDML() {
    const { nbh, nbh: { models } } = this;
    // deno-fmt-ignore
    return nbh.SQL`
      ${nbh.loadExtnSQL("asg017/ulid/ulid0")}
      ${nbh.loadExtnSQL("asg017/http/http0")}

      -- This source: 'https://raw.githubusercontent.com/patrickmccallum/mimetype-io/master/src/mimeData.json'
      -- has the given JSON structure:
      -- [
      --   {
      --     "name": <MimeTypeName>,
      --     "description": <Description>,
      --     "types": [<Extension1>, <Extension2>, ...],
      --     "alternatives": [<Alternative1>, <Alternative2>, ...]
      --   },
      --   ...
      -- ]
      -- The goal of the SQL query is to flatten this structure into rows where each row will
      -- represent a single MIME type and one of its associated file extensions (from the 'types' array).
      -- The output will look like:
      -- | name             | description  | type         | alternatives        |
      -- |------------------|--------------|--------------|---------------------|
      -- | <MimeTypeName>   | <Description>| <Extension1> | <AlternativesArray> |
      -- | <MimeTypeName>   | <Description>| <Extension2> | <AlternativesArray> |
      -- ... and so on for all MIME types and all extensions.
      --
      -- we take all those JSON array entries and insert them into our MIME Types table
      INSERT or IGNORE INTO mime_type (mime_type_id, name, description, file_extn)
        SELECT ulid(),
               resource.value ->> '$.name' as name,
               resource.value ->> '$.description' as description,
               file_extns.value as file_extn
          FROM json_each(http_get_body('https://raw.githubusercontent.com/patrickmccallum/mimetype-io/master/src/mimeData.json')) as resource,
               json_each(resource.value, '$.types') AS file_extns;

      ${models.mimeType.insertDML({
          mime_type_id: nbh.sqlEngineNewUlid,
          name: "application/typescript",
          file_extn: ".ts",
          description: "Typescript source",
        }, { onConflict: nbh.onConflictDoNothing })};`;
  }

  // TODO: convert arguments to Zod so that they can be validated from external sources?
  async insertContent(
    options?: {
      deviceName?: string;
      deviceBoundary?: string;
      paths?: string[];
      ignorePathsRegEx?: string;
      blobsRegEx?: string;
      digestsRegEx?: string;
      maxFileIoReadBytes?: number;
    },
  ): Promise<SQLa.SqlTextSupplier<EmitContext>> {
    const {
      nbh,
      nbh: { models, sch, sqlEngineNewUlid, onConflictDoNothing },
    } = this;
    const adi = await sch.activeDeviceInsertable();
    const deviceName = options?.deviceName ?? adi.name;
    const deviceBoundary = options?.deviceBoundary ?? adi.boundary;

    // we use ON CONFLICT DO NOTHING in case this device is already defined
    const activeDeviceDML = models.device.insertDML(adi, {
      onConflict: onConflictDoNothing,
    });

    // for all regular expressions we use ags017/regex Rust extension so
    // test with https://regex101.com/ ("Rust" flavor, remove \\ and use \ for tests)

    const paths = options?.paths ?? [Deno.cwd()];
    const blobsRegEx = options?.blobsRegEx ?? "\\.(md|mdx|html|json)$";
    const digestsRegEx = options?.digestsRegEx ?? ".*";
    const ignorePathsRegEx = options?.ignorePathsRegEx ??
      "/(\\.git|node_modules)/";
    const maxFileIoReadBytes = options?.maxFileIoReadBytes ?? 1000000000;

    // use abbreviations for easier to read templating
    const {
      universal: { sqliteParameters: sqp },
      fsContentWalkSession: fscws,
      fsContentWalkPath: fscwp,
      fsContent: fsc,
      fsContentWalkPathEntry: fscwpe,
    } = models;

    // setup the SQL bind parameters that will be used in this block;
    // object property values will be available as :device_id, etc.
    const bindParams = Object.entries({
      max_fileio_read_bytes: maxFileIoReadBytes,
      ignore_paths_regex: ignorePathsRegEx,
      blobs_regex: blobsRegEx,
      digests_regex: digestsRegEx,
      device_id: models.device.select({
        name: deviceName,
        boundary: deviceBoundary,
      }),
    }).map(([key, value]) =>
      sqp.insertDML({
        key: `:${key}`,
        value: typeof value === "number" ? String(value) : value,
      })
    );

    return {
      SQL: (ctx: EmitContext) => {
        // get column names for easier to read templating
        //
        const { useBind: d_useb } = models.device.columnNames(ctx);
        const { symbol: fscws_c, defineBind: fscws_defb, useBind: fscws_useb } =
          fscws.columnNames(ctx);
        // const { stsb: fscwpb } = fscwp.columnNames(ctx);
        // const { stsb: fscb } = fsc.columnNames(ctx);

        // deno-fmt-ignore
        return nbh.SQL`
          ${nbh.optimalOpenDB}
          ${nbh.loadExtnSQL("asg017/ulid/ulid0")}
          ${nbh.loadExtnSQL("nalgeon/fileio/fileio")}
          ${nbh.loadExtnSQL("nalgeon/crypto/crypto")}
          ${nbh.loadExtnSQL("asg017/path/path0")}
          ${nbh.loadExtnSQL("asg017/regex/regex0")}

          ${activeDeviceDML}

          .parameter init
          ${bindParams}

          ${fscws.insertDML({
            fs_content_walk_session_id: sqlEngineNewUlid,
            device_id: d_useb.device_id,
            walk_started_at: { SQL: () => `CURRENT_TIMESTAMP` },
            max_fileio_read_bytes: { SQL: () => `:max_fileio_read_bytes` },
            blobs_regex: { SQL: () => `:blobs_regex` },
            digests_regex: { SQL: () => `:digests_regex` },
            ignore_paths_regex: { SQL: () => `:ignore_paths_regex` },
          })}
          ${sqp.insertDML({ key: fscws_defb.fs_content_walk_session_id, value: { SQL: () => `SELECT fs_content_walk_session_id FROM fs_content_walk_session ORDER BY created_at DESC LIMIT 1` } })}

          ${fscwp.insertDML(paths.map((root_path) => ({
            fs_content_walk_path_id: sqlEngineNewUlid,
            walk_session_id: fscws_useb.fs_content_walk_session_id,
            root_path })))}

          -- if something's not working, use '.parameter list' to see the bind parameters from SQL
          -- .parameter list

          -- This SQL statement inserts data into the fs_content table, generating values for some columns
          -- and conditionally computing content and hashes (content digests) for certain files based on
          -- provided criteria and functions. It takes care to avoid inserting duplicate entries into the
          -- table so if the file is already in the table, it does not insert it again. When a file is
          -- inserted, it is stored with the walk_path_id that is associated with the walk_path that the
          -- file was found in. This allows us to easily find all files that were found in a particular
          -- walk session and we can run simple queries to see which files were added or updated in a
          -- specific session. There is support for detecting file deletes by using path entries.
          -- fs_content_walk_path_entry.
          -- we use nalgeon/fileio extension to read directories and asg017/path to compute paths;
          INSERT OR IGNORE INTO ${fsc.tableName} (fs_content_id, walk_session_id, walk_path_id, file_path, file_extn, file_bytes, file_mtime, file_mode, file_mode_human, content, content_digest)
            SELECT ulid() as fs_content_id,
                  walk_session_id,
                  fs_content_walk_path_id,
                  name AS file_path,
                  path_extension(name) as file_extn,
                  size as file_bytes,
                  mtime as file_mtime,
                  mode as file_mode,
                  fileio_mode(mode) as file_mode_human,
                  CASE WHEN regex_find(:blobs_regex, name) IS NOT NULL AND size < :max_fileio_read_bytes THEN fileio_read(name) ELSE NULL END AS content,
                  CASE WHEN regex_find(:digests_regex, name) IS NOT NULL AND size < :max_fileio_read_bytes THEN hex(sha256(fileio_read(name))) ELSE '-' END AS content_digest
              FROM ${fscwp.tableName},
                  fileio_ls(root_path, true) as ls -- true indicates recursive listing
            WHERE walk_session_id = :fs_content_walk_session_id
              AND (file_mode_human like '-%' or file_mode_human like 'l%') -- only files or symlinks, not directories
              AND regex_find(:ignore_paths_regex, name) IS NULL;

          -- this second pass walks the path again and connects all found files to the immutable fs_content
          -- table; this is necessary so that if any files were removed in a subsequent session, the
          -- immutable fs_content table would still contain the file for history but it would not show up in
          -- fs_content_walk_path_entry;
          -- NOTE: we denormalize and compute using path_dirname, path_basename, path_extension, etc. so that
          -- the ulid(), path_*, and other extensions are only needed on inserts, not reads.
          INSERT INTO ${fscwpe.tableName} (fs_content_walk_path_entry_id, walk_session_id, walk_path_id, fs_content_id, file_path_abs, file_path_rel_parent, file_path_rel, file_basename, file_extn)
            SELECT ulid() as fs_content_walk_path_entry_id,
                    fscwp.walk_session_id as walk_session_id,
                    fscwp.fs_content_walk_path_id as walk_path_id,
                    fsc.fs_content_id,
                    ls.name AS file_path,
                    path_dirname(substr(ls.name, length(root_path) + 1)) AS file_path_rel_parent,
                    substr(ls.name, length(root_path) + 1) AS file_path_rel,
                    path_basename(name) as file_basename,
                    path_extension(name) as file_extn
              FROM fileio_ls(root_path, true) as ls
                    INNER JOIN ${fscwp.tableName} as fscwp ON fscwp.walk_session_id = :fs_content_walk_session_id
                    LEFT JOIN fs_content AS fsc ON fsc.file_path = ls.name
              WHERE ((ls.mode & 61440) = 32768  /* Regular file */ OR (ls.mode & 61440) = 40960 /* Symbolic link */)
                AND regex_find(:ignore_paths_regex, ls.name) IS NULL
                AND fsc.created_at = (SELECT MAX(created_at) FROM fs_content WHERE file_path = ls.name);

          -- TODO: add SQLa 'updateDML' generator like insertDML
          UPDATE ${fscws.tableName} SET ${fscws_c.walk_finished_at} = CURRENT_TIMESTAMP WHERE ${fscws_c.fs_content_walk_session_id} = ${fscws_useb.fs_content_walk_session_id};
          ${nbh.optimalCloseDB}`.SQL(ctx);
      },
    };
  }

  async SQLPageSeedDML() {
    const kernel = nb.ObservableKernel.create(SQLPageNotebook.prototype);
    const { universal: um } = this.nbh.models;
    const ctx = um.modelsGovn.sqlEmitContext<EmitContext>();

    // prepare the run state with list of all pages defined
    const irs = await kernel.initRunState();
    const sqlDML: SQLa.SqlTextSupplier<EmitContext>[] = [];
    irs.runState.eventEmitter.afterCell = (cell, state) => {
      if (state.status == "successful") {
        sqlDML.push(um.sqlPageFiles.insertDML({
          path: cell, // the class's method name is the "cell"
          // deno-fmt-ignore
          contents: SQLa.isSqlTextSupplier<EmitContext>(state.execResult)
            ? state.execResult.SQL(ctx)
            : `select 'alert' as component,
                      'MutationSqlNotebook.SQLPageSeedDML() issue' as title,
                      'SQLPageNotebook cell "${cell}" did not return SQL (found: ${typeof state.execResult})' as description;`,
          last_modified: { SQL: () => `CURRENT_TIMESTAMP` },
        }, {
          onConflict: {
            SQL: () =>
              `ON CONFLICT(path) DO UPDATE SET contents = EXCLUDED.contents, last_modified = CURRENT_TIMESTAMP`,
          },
        }));
      }
    };

    await kernel.run(new SQLPageNotebook<EmitContext>(this.nbh), irs);
    return this.nbh.SQL`
      ${this.nbh.optimalOpenDB}
      ${sqlDML};
      ${this.nbh.optimalCloseDB}
      `;
  }
}

export class QuerySqlNotebook<
  EmitContext extends SQLa.SqlEmitContext = SQLa.SqlEmitContext,
> extends SQLa.SqlNotebook<EmitContext> {
  static identity = this.constructor.name;

  constructor(readonly nbh: SqlNotebookHelpers<EmitContext>) {
    super();
  }

  /*
   * This SQL statement retrieves column information for tables in an SQLite database
   * including table name, column ID, column name, data type, nullability, default
   * value, and primary key status.
   * It filters only tables from the result set. It is commonly used for analyzing
   * and documenting database schemas.
   * NOTE: pragma_table_info(m.tbl_name) will only work when m.type is 'table'
   * TODO: add all the same content that is emitted by infoSchemaMarkdown
   */
  infoSchema() {
    return this.nbh.SQL`
      SELECT
          tbl_name AS table_name,
          c.cid AS column_id,
          c.name AS column_name,
          c."type" AS "type",
          c."notnull" AS "notnull",
          c.dflt_value as "default_value",
          c.pk AS primary_key
      FROM
          sqlite_master m,
          pragma_table_info(m.tbl_name) c
      WHERE
          m.type = 'table';`;
  }

  /**
   * SQL which generates the Markdown content lines (rows) which describes all
   * the tables, columns, indexes, and views in the database. This should really
   * be a view instead of a query but SQLite does not support use of pragma_* in
   * views for security reasons.
   */
  infoSchemaMarkdown() {
    this.nbh.SQL`
      WITH TableInfo AS (
        SELECT
          m.tbl_name AS table_name,
          CASE WHEN c.pk THEN '*' ELSE '' END AS is_primary_key,
          c.name AS column_name,
          c."type" AS column_type,
          CASE WHEN c."notnull" THEN '*' ELSE '' END AS not_null,
          COALESCE(c.dflt_value, '') AS default_value,
          COALESCE((SELECT pfkl.'table' || '.' || pfkl.'to' FROM pragma_foreign_key_list(m.tbl_name) AS pfkl WHERE pfkl.'from' = c.name), '') as fk_refs,
          ROW_NUMBER() OVER (PARTITION BY m.tbl_name ORDER BY c.cid) AS row_num
        FROM sqlite_master m JOIN pragma_table_info(m.tbl_name) c ON 1=1
        WHERE m.type = 'table'
        ORDER BY table_name, row_num
      ),
      Views AS (
        SELECT '## Views ' AS markdown_output
        UNION ALL
        SELECT '| View | Column | Type |' AS markdown_output
        UNION ALL
        SELECT '| ---- | ------ |----- |' AS markdown_output
        UNION ALL
        SELECT '| ' || tbl_name || ' | ' || c.name || ' | ' || c."type" || ' | '
        FROM
          sqlite_master m,
          pragma_table_info(m.tbl_name) c
        WHERE
          m.type = 'view'
      ),
      Indexes AS (
        SELECT '## Indexes' AS markdown_output
        UNION ALL
        SELECT '| Table | Index | Columns |' AS markdown_output
        UNION ALL
        SELECT '| ----- | ----- | ------- |' AS markdown_output
        UNION ALL
        SELECT '| ' ||  m.name || ' | ' || il.name || ' | ' || group_concat(ii.name, ', ') || ' |' AS markdown_output
        FROM sqlite_master as m,
          pragma_index_list(m.name) AS il,
          pragma_index_info(il.name) AS ii
        WHERE
          m.type = 'table'
        GROUP BY
          m.name,
          il.name
      )
      SELECT
        markdown_output AS markdown_result
      FROM
        (
          SELECT '## Tables' AS markdown_output
          UNION ALL
          SELECT
            CASE WHEN ti.row_num = 1 THEN '
      ### \`' || ti.table_name || '\` Table
      | PK | Column | Type | Req? | Default | References |
      | -- | ------ | ---- | ---- | ------- | ---------- |
      ' ||
              '| ' || is_primary_key || ' | ' || ti.column_name || ' | ' || ti.column_type || ' | ' || ti.not_null || ' | ' || ti.default_value || ' | ' || ti.fk_refs || ' |'
            ELSE
              '| ' || is_primary_key || ' | ' || ti.column_name || ' | ' || ti.column_type || ' | ' || ti.not_null || ' | ' || ti.default_value || ' | ' || ti.fk_refs || ' |'
            END
          FROM TableInfo ti
          UNION ALL SELECT ''
          UNION ALL SELECT * FROM	Views
          UNION ALL SELECT ''
          UNION ALL SELECT * FROM Indexes
      );`;
  }

  htmlAnchors() {
    // deno-fmt-ignore
    return this.nbh.SQL`
        ${this.nbh.loadExtnSQL("asg017/html/html0")}

        -- find all HTML files in the fs_content table and return
        -- each file and the anchors' labels and hrefs in that file
        -- TODO: create a table called fs_content_html_anchor to store this data after inserting it into fs_content
        --       so that simple HTML lookups do not require the html0 extension to be loaded
        WITH html_content AS (
          SELECT fs_content_id, content, content_digest, file_path, file_extn FROM fs_content WHERE file_extn = '.html'
        ),
        html AS (
          SELECT file_path,
                 text as label,
                 html_attribute_get(html, 'a', 'href') as href
            FROM html_content, html_each(html_content.content, 'a')
        )
        SELECT * FROM html;
      `;
  }

  htmlHeadMeta() {
    // deno-fmt-ignore
    return this.nbh.SQL`
        ${this.nbh.loadExtnSQL("asg017/html/html0")}

        -- find all HTML files in the fs_content table and return
        -- each file and the <head><meta name="key" content="value"> pair
        -- TODO: create a table called fs_content_html_head_meta to store this data after inserting it into fs_content
        --       so that simple HTML lookups do not require the html0 extension to be loaded
        WITH html_content AS (
          SELECT fs_content_id, content, content_digest, file_path, file_extn FROM fs_content WHERE file_extn = '.html'
        ),
        html AS (
          SELECT file_path,
                 html_attribute_get(html, 'meta', 'name') as key,
                 html_attribute_get(html, 'meta', 'content') as value,
                 html
            FROM html_content, html_each(html_content.content, 'head meta')
           WHERE key IS NOT NULL
        )
        SELECT * FROM html;
      `;
  }
}

export class PolyglotSqlNotebook<
  EmitContext extends SQLa.SqlEmitContext = SQLa.SqlEmitContext,
> extends SQLa.SqlNotebook<EmitContext> {
  static identity = this.constructor.name;

  constructor(readonly nbh: SqlNotebookHelpers<EmitContext>) {
    super();
  }

  async postProcessFsContent(
    options?: {
      readonly ctx?: EmitContext;
      readonly potentialFmFilesRegEx?: string;
    },
  ): Promise<SQLa.SqlTextSupplier<EmitContext> | undefined> {
    const potentialFmFilesRegEx = options?.potentialFmFilesRegEx ??
      "\\.(md|mdx)$";

    const { nbh, nbh: { models, loadExtnSQL, execDbQueryResult } } = this;
    const unparsedFM = await execDbQueryResult<
      { fs_content_id: string; content: string }
    >(nbh.SQL`
      ${loadExtnSQL("asg017/regex/regex0")}

      SELECT fs_content_id, content
        FROM fs_content
      WHERE regex_find('${potentialFmFilesRegEx}', file_path) IS NOT NULL
        AND content IS NOT NULL
        AND content_fm_body_attrs IS NULL
        AND frontmatter IS NULL;`.SQL(
      options?.ctx ?? models.universal.modelsGovn.sqlEmitContext(),
    ));

    if (unparsedFM) {
      return {
        SQL: (ctx) => {
          const { quotedLiteral } = ctx.sqlTextEmitOptions;
          const updatedFM: string[] = [];
          for (const ufm of unparsedFM) {
            if (fm.test(ufm.content)) {
              const parsedFM = fm.extract(ufm.content);
              // deno-fmt-ignore
              updatedFM.push(`UPDATE fs_content SET frontmatter = ${quotedLiteral(JSON.stringify(parsedFM.attrs))[1]}, content_fm_body_attrs = ${quotedLiteral(JSON.stringify(parsedFM))[1]} where fs_content_id = '${ufm.fs_content_id}';`);
            }
          }
          // deno-fmt-ignore
          return updatedFM.join("\n");
        },
      };
    }
    return undefined;
  }
}

/**
 * SqlPageNotebook has methods with the name of each [SQLPage](https://sql.ophir.dev/)
 * content that we want in the database. The MutationSqlNotebook sqlPageSeedDML
 * method "reads" the cells in the SqlPageNotebook (each method's result) and
 * generates SQL to insert the content of the page in the database in the format
 * and table expected by [SQLPage](https://sql.ophir.dev/).
 * NOTE: we break our PascalCase convention for the name of the class since SQLPage
 *       is a proper noun (product name).
 */
export class SQLPageNotebook<
  EmitContext extends SQLa.SqlEmitContext = SQLa.SqlEmitContext,
> extends SQLa.SqlNotebook<EmitContext> {
  static identity = this.constructor.name;

  constructor(readonly nbh: SqlNotebookHelpers<EmitContext>) {
    super();
  }

  "index.sql"() {
    return this.nbh.SQL`
      SELECT
        'list' as component,
        'Get started: where to go from here ?' as title,
        'Here are some useful links to get you started with SQLPage.' as description;
      SELECT 'Content Walk Session Statistics' as title,
        'fsc-walk-session-stats.sql' as link,
        'TODO' as description,
        'green' as color,
        'download' as icon;
      SELECT 'MIME Types' as title,
        'mime-types.sql' as link,
        'TODO' as description,
        'blue' as color,
        'download' as icon;`;
  }

  "fsc-walk-session-stats.sql"() {
    return this.nbh.SQL`
      SELECT 'table' as component, 1 as search, 1 as sort;
      SELECT walk_datetime, walk_duration, file_extn, total_count, with_frontmatter, average_size from fs_content_walk_session_stats;`;
  }

  "mime-types.sql"() {
    return this.nbh.SQL`
      SELECT 'table' as component, 1 as search, 1 as sort;
      SELECT name, file_extn, description from mime_type;`;
  }

  "bad-item.sql"() {
    return "this is not a proper return type in SQLPageNotebook so it should generate an alert page in SQLPage";
  }

  // TODO: add one or more pages that will contain PlantUML or database
  //       description markdown so that the documentation for the database
  //       is contained within the DB itself.
}

export class SqlNotebooksOrchestrator<
  EmitContext extends SQLa.SqlEmitContext = SQLa.SqlEmitContext,
> {
  readonly cnf: ReturnType<
    typeof SQLa.sqlNotebookFactory<ConstructionSqlNotebook, EmitContext>
  >;
  readonly mnf: ReturnType<
    typeof SQLa.sqlNotebookFactory<MutationSqlNotebook, EmitContext>
  >;

  constructor(readonly nbh: SqlNotebookHelpers<EmitContext>) {
    this.cnf = SQLa.sqlNotebookFactory(
      ConstructionSqlNotebook.prototype,
      () => new ConstructionSqlNotebook<EmitContext>(nbh, []),
    );
    this.mnf = SQLa.sqlNotebookFactory(
      MutationSqlNotebook.prototype,
      () => new MutationSqlNotebook<EmitContext>(nbh),
    );
  }

  separator(cell: string) {
    return {
      executeSqlBehavior: () => ({
        SQL: () => `\n---\n--- Cell: ${cell}\n---\n`,
      }),
    };
  }
}