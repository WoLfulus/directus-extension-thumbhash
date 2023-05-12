import {
  type FieldsService,
  type FilesService,
  type ItemsService,
  type AssetsService,
} from "@directus/api";
import { type HookConfig } from "@directus/types";
import { type File } from "@directus/api/dist/types";
import { defineHook } from "@directus/extensions-sdk";

import * as thumbhash from "thumbhash";

export default defineHook<HookConfig>(async function (
  { init, action },
  { database, services, getSchema }
) {
  let sharp: any = null;

  try {
    sharp = require("sharp");
  } catch (error) {
    console.log(error);
    process.exit(1);
  }

  const fieldsService: typeof FieldsService = services.FieldsService;
  async function getFieldsService() {
    return new fieldsService({ knex: database, schema: await getSchema() });
  }

  const filesService: typeof FilesService = services.FilesService;
  async function getFilesService() {
    return new filesService({
      knex: database,
      schema: await getSchema(),
    }) as FilesService & ItemsService<File>;
  }

  const assetsService: typeof AssetsService = services.AssetsService;
  async function getAssetsService() {
    return new assetsService({ knex: database, schema: await getSchema() });
  }

  const itemsService: typeof ItemsService = services.ItemsService;
  async function getItemsService(collection: string) {
    return new itemsService(collection, {
      knex: database,
      schema: await getSchema(),
    });
  }

  async function ensureRequiredFields() {
    const fields = await getFieldsService();

    const thumbhashField: Record<string, any> | null = await fields
      .readOne("directus_files", "thumbhash")
      .catch(() => null);

    if (!thumbhashField) {
      await fields.createField("directus_files", {
        collection: "directus_files",
        field: "thumbhash",
        type: "string",
        schema: {
          name: "thumbhash",
          table: "directus_files",
          data_type: "varchar",
          default_value: null,
          max_length: 255,
          is_nullable: true,
          foreign_key_column: null,
          foreign_key_table: null,
          has_auto_increment: false,
          is_generated: false,
          is_primary_key: false,
          is_unique: false,
          numeric_precision: null,
          numeric_scale: null,
          comment: null,
          foreign_key_schema: null,
          generation_expression: null,
        },
        meta: {
          collection: "directus_files",
          field: "thumbhash",
          interface: "input",
          options: {
            iconLeft: "lens_blur",
          },
          display: null,
          display_options: {},
          special: null,
          group: null,
          hidden: false,
          readonly: false,
          required: false,
          sort: null,
          translations: null,
          width: null,
          note: null,
          conditions: null,
          validation: null,
          validation_message: null,
        } as any,
      });
    }
  }

  async function generateThumbHash(key: string, force: boolean = false) {
    const assets = await getAssetsService();
    const files = await getFilesService();

    const file = (await files.readOne(key, {
      fields: ["id", "thumbhash", "type", "width", "height"],
    })) as File & {
      thumbhash?: string | null;
    };

    if (!file) {
      console.log("[thumbhash] failed to fetch file with key: ", key);
      return;
    }

    if ((file.thumbhash || "").length > 0 && !force) {
      console.log("[thumbhash] file already has thumbhash: ", key);
      return;
    }

    if (
      file.width === null ||
      file.height === null ||
      !file.type?.startsWith("image/") ||
      file.type?.includes("svg")
    ) {
      console.log("[thumbhash] skipping unsupported file type: ", file.type);
      return;
    }

    let resize = {
      width:
        file.width > file.height
          ? 100
          : file.width == file.height
          ? 100
          : undefined,
      height:
        file.height > file.width
          ? 100
          : file.width == file.height
          ? 100
          : undefined,
    };

    const asset = await assets.getAsset(file.id, {
      key: undefined,
      withoutEnlargement: true,
      format: "webp",
      ...resize,
    });

    const chunks: Buffer[] = [];
    for await (const chunk of asset.stream) {
      chunks.push(chunk);
    }

    const image = await new Promise<
      | {
          buffer: Buffer;
          info: {
            width: number;
            height: number;
          };
        }
      | {
          error: Error;
        }
    >(async (resolve, reject) => {
      try {
        sharp(Buffer.concat(chunks))
          .raw()
          .ensureAlpha()
          .toBuffer(
            (
              error: Error,
              buffer: Buffer,
              info: { width: number; height: number }
            ) => {
              if (error) {
                reject(error);
              }
              resolve({
                buffer,
                info,
              });
            }
          );
      } catch (error) {
        console.log(error);
        // reject(error);
        resolve({
          error,
        });
      }
    });

    if ("error" in image) {
      console.log(
        "[thumbhash] failed to generate image: ",
        image.error.message
      );
      return;
    }

    const hash = Buffer.from(
      thumbhash.rgbaToThumbHash(
        image.info.width,
        image.info.height,
        image.buffer
      )
    ).toString("base64");

    await files.updateOne(file.id, { thumbhash: hash });
  }

  init("routes.custom.after", async () => {
    await ensureRequiredFields();
  });

  action(
    "files.upload",
    async function (
      { payload, key, collection },
      { database, schema, accountability }
    ) {
      try {
        await generateThumbHash(key, true);
      } catch (error) {
        console.log("[thumbhash] file update error: " + error);
      }
    }
  );

  action(
    "files.update",
    async function (
      { payload, keys, collection },
      { database, schema, accountability }
    ) {
      for await (const key of keys) {
        try {
          await generateThumbHash(key, false);
        } catch (error) {
          console.log("[thumbhash] file update error: " + error);
        }
      }
    }
  );
}) as any;
