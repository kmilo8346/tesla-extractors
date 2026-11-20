import z from 'zod';
import axios from 'axios';
import PDFParser, { Output, Text } from 'pdf2json';
import {
  FileData,
  FileOuput,
  MonthDateId,
  MonthExtractor,
} from '../../../../lib';

const SOURCE_URL = 'https://www.bovag.nl/pers/cijfers';

class Extractor extends MonthExtractor {
  constructor() {
    super({
      folders: ['car_registrations', 'countries', 'netherlands'],
      source: 'bovag',
      fileext: 'pdf',
    });
  }

  async download(dateId: MonthDateId): Promise<Buffer | null> {
    const { year, month } = dateId;

    const monthMap = {
      1: 'januari',
      2: 'februari',
      3: 'maart',
      4: 'april',
      5: 'mei',
      6: 'juni',
      7: 'juli',
      8: 'augustus',
      9: 'september',
      10: 'oktober',
      11: 'november',
      12: 'december',
    };
    const expectedTitle = `Autoverkopen ${monthMap[month]} ${year}`;

    // La lista desplegable de la página ya no muestra los meses antiguos,
    // pero el html trae los datos de todas las descargas
    // con su url y su título, por ejemplo:
    // "url":"https://cdn.sanity.io/...pdf"},"originalFilename":"..."},"title":"Autoverkopen mei 2025"
    const response = await axios.get(SOURCE_URL);
    const downloadRegex =
      /"url":"(https:\/\/[^"]+?\.pdf)"\},"originalFilename":"(?:[^"\\]|\\.)*"\},"title":"([^"]+)"/g;
    const urls = new Set<string>();
    for (const match of (response.data as string).matchAll(downloadRegex)) {
      if (match[2] === expectedTitle) {
        urls.add(match[1]);
      }
    }

    // Informo que no hay datos para descargar
    if (urls.size === 0) {
      return null;
    }
    if (urls.size > 1) {
      throw new Error(`More than one file found for "${expectedTitle}"`);
    }

    const fileContent = await axios([...urls][0], {
      responseType: 'arraybuffer',
    });

    return fileContent.data;
  }

  async transform(
    dateId: MonthDateId,
    fileData: FileData
  ): Promise<FileOuput[]> {
    const pdfJSON = await new Promise<Output>((resolve, reject) => {
      const pdfParser = new PDFParser();

      pdfParser.on('pdfParser_dataError', (errData) =>
        reject(errData.parserError)
      );

      pdfParser.on('pdfParser_dataReady', async (pdfData) => {
        resolve(pdfData);
      });

      pdfParser.loadPDF(fileData.path);
    });

    const registrations = [];
    for (let i = 0; i < pdfJSON.Pages.length; i++) {
      const texts = pdfJSON.Pages[i].Texts;

      // Armo la tabla usando las coordenadas
      const TOLERANCE = 0.048;
      const rows: Text[][] = [];
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i];

        // Busco a que row pertenece
        // Si no hay ninguno, se crea un nuevo row
        const match = rows.find((row) => {
          return Math.abs(row[0].y - text.y) <= TOLERANCE;
        });
        if (match) {
          match.push(text);
        } else {
          rows.push([text]);
        }
      }

      let modified = [...rows];
      // En la primera página tengo eliminar
      // las filas del header
      if (i === 0) {
        // Elimino rows del header
        // que termina en el row que
        // que parte con el texto "MERK%20%2F%20MODEL"
        const startIndex = modified.findIndex((row) => {
          return row[0].R[0].T === 'MERK%20%2F%20MODEL';
        });
        modified = modified.slice(startIndex + 1);
      }

      // Elimino los rows que tiene un solo elemento
      // estos son espacios al final de las páginas
      modified = modified.filter((row) => row.length > 1);

      // Valida que todas las filas tengan 5 columnas
      const tableIsValid = modified.every((row) => row.length === 5);
      if (!tableIsValid) {
        // // DEBUG CODE
        // const tmpFile2 = path.join(os.tmpdir(), `${new Date().valueOf()}.json`);
        // await writeFile(
        //   tmpFile2,
        //   JSON.stringify(
        //     {
        //       date_id: dateId,
        //       page_index: i,
        //       row_lengths: rows.map((row) => row.length),
        //       rows: rows.map((row) => {
        //         return row.map((text) => {
        //           return {
        //             x: text.x,
        //             y: text.y,
        //             text: text.R[0].T,
        //           };
        //         });
        //       }),
        //     },
        //     null,
        //     2
        //   )
        // );
        // execSync(`code ${tmpFile2}`);

        throw new Error('Invalid number of columns found');
      }

      // Valido los datos y los agrego
      // a la lista de registrations
      const Schema = z.object({
        year: z.number().int().min(1900).max(2100),
        month: z.number().int().min(1).max(12),
        model: z.preprocess((value: string) => {
          return decodeURIComponent(value).trim().toUpperCase();
        }, z.string()),
        registrations: z.preprocess((value: string) => {
          return parseInt(
            decodeURIComponent(value).trim().replace(/\./g, ''),
            10
          );
        }, z.number()),
      });
      for (const row of modified) {
        const parsed = Schema.parse({
          year: dateId.year,
          month: dateId.month,
          model: row[0].R[0].T,
          registrations: row[1].R[0].T,
        });
        registrations.push(parsed);
      }
    }

    return [
      {
        name: 'registrations_by_model',
        data: registrations,
      },
    ];
  }

  async debug() {}
}

export default new Extractor();
