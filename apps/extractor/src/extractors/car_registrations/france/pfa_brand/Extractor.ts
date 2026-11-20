import axios from 'axios';
import * as cheerio from 'cheerio';
import PDFParser, { Output, Text } from 'pdf2json';
import z from 'zod';
import {
  FileData,
  FileOuput,
  MonthDateId,
  MonthExtractor,
} from '../../../../lib';

const POSTS_URL = 'https://pfa-auto.fr/wp-json/wp/v2/posts';

class Extractor extends MonthExtractor {
  constructor() {
    super({
      folders: ['car_registrations', 'countries', 'france'],
      source: 'pfa_brand',
      fileext: 'pdf',
    });
  }

  async download(dateId: MonthDateId): Promise<Buffer | null> {
    const { month, year } = dateId;

    const MONTH_MAP = {
      1: 'janvier',
      2: 'fevrier',
      3: 'mars',
      4: 'avril',
      5: 'mai',
      6: 'juin',
      7: 'juillet',
      8: 'aout',
      9: 'septembre',
      10: 'octobre',
      11: 'novembre',
      12: 'decembre',
    };

    // Busco el artículo del mes por su slug, la lista de la página
    // principal no siempre muestra todos los artículos
    const response = await axios.get(POSTS_URL, {
      params: {
        slug: `marche-automobile-francais-${MONTH_MAP[month]}-${year}`,
        _fields: 'content',
      },
    });

    // Informo que no hay datos publicados aún
    if (response.data.length === 0) {
      return null;
    }

    // Descargo el documento con datos esenciales ("Flash")
    // lo identifico por el nombre del archivo y no por el texto del link
    const $ = cheerio.load(response.data[0].content.rendered);
    const downloadUrls = [
      ...new Set(
        Array.from($('a'))
          .map((aElement) => $(aElement).attr('href'))
          .filter((href) => href && /flash[^/]*\.pdf$/i.test(href))
      ),
    ];
    if (downloadUrls.length !== 1) {
      console.debug({
        year,
        month,
        downloadUrls,
      });
      throw new Error('Expected document not found');
    }

    const fileContent = await axios(downloadUrls[0], {
      responseType: 'arraybuffer',
    });

    return fileContent.data;
  }

  async transform(
    dateId: MonthDateId,
    fileData: FileData
  ): Promise<FileOuput[]> {
    const { year, month } = dateId;

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

    // Me quedo con los textos de la página 2
    // La tabla siempre está en la página 2
    const texts = pdfJSON.Pages[1].Texts;

    // Armo la tabla usando las coordenadas
    // Para crear un row necesito dejar en un arreglo
    // los que tenga la y igual o muy cercana
    const TOLERANCE = 0.02;
    let rows: Text[][] = [];
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];

      // Busco a que row pertenece
      // Si no hay ninguno, se crea un nuevo row
      const match = rows.find((row) => {
        return Math.abs(row[0].y - text.y) < TOLERANCE;
      });
      if (match) {
        match.push(text);
      } else {
        rows.push([text]);
      }
    }

    // Encuentro la ubicación del primer row de la tabla
    // el que dice "TOTAL MARCHE", a partir de ahí
    // se encuentran los datos de la tabla
    const totalMarcheIndex = rows.findIndex((row) => {
      return decodeURIComponent(row[0].R[0].T) === 'TOTAL MARCHE';
    });

    // Me quedo con los rows que están
    // después de "TOTAL MARCHE"
    rows = rows.slice(totalMarcheIndex + 1);

    // Encuentro la ubicación del último row de la tabla
    // el que dice "AUSTRES", a partir de ahí elimino lo que sigue
    const austresIndex = rows.findIndex((row) => {
      return decodeURIComponent(row[0].R[0].T) === 'AUSTRES';
    });
    rows = rows.slice(0, austresIndex);

    // Valido con zod
    const Schema = z
      .object({
        year: z.number().int(),
        month: z.number().int(),
        brand: z.preprocess(
          (val: string) =>
            decodeURIComponent(val).trim().toUpperCase().replace(/\s+/g, '_'),
          z.string()
        ),
        registrations: z.preprocess(
          (val: string) =>
            parseInt(decodeURIComponent(val).replace(/\s/g, ''), 10),
          z.number().int()
        ),
        market_share: z.preprocess(
          (val: string) =>
            parseFloat(
              decodeURIComponent(val).replace(/\s/g, '').replace(',', '.')
            ),
          z.number()
        ),
      })
      .strict();
    type Registrations = z.infer<typeof Schema>;

    const registrations: Registrations[] = [];
    for (const row of rows) {
      const parsed = Schema.parse({
        year,
        month,
        brand: row[0].R[0].T,
        registrations: row[3].R[0].T,
        market_share: row[4].R[0].T,
      });
      registrations.push(parsed);
    }

    return [
      {
        name: 'registrations_by_brand',
        data: registrations,
      },
    ];
  }

  async debug() {}
}

export default new Extractor();
