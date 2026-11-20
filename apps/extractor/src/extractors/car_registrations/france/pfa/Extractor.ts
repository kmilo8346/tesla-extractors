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
      source: 'pfa',
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

    // Descargo el documento con datos detallados ("Dossier de presse")
    // lo identifico por el nombre del archivo y no por el texto del link
    const $ = cheerio.load(response.data[0].content.rendered);
    const downloadUrls = [
      ...new Set(
        Array.from($('a'))
          .map((aElement) => $(aElement).attr('href'))
          .filter((href) => href && /dossier-de-presse[^/]*\.pdf$/i.test(href))
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

    // La tabla siempre está en la página 18
    // así reduzco el espacio de búsqueda
    const texts = pdfJSON.Pages[17].Texts;

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

    // Hay rows que tiene 20 columnas en vez de 16
    // esto ocurre pq el primero top 10 está en negritas
    // y duplica cada texto pq es otro formato
    // si tiene length 20 elimino los ultimos 4 elementos
    rows = rows.map((row) => {
      if (row.length === 20) {
        return row.slice(0, 16);
      }
      return row;
    });

    // Dejo solo los rows que tengan 16 columnas
    rows = rows.filter((row) => row.length === 16);

    // Ordenos los rows por x
    rows = rows.map((row) => {
      return row.sort((a, b) => a.x - b.x);
    });

    // Valido los YTD Registrations con zod
    const YTDRegistrationsSchema = z
      .object({
        year: z.number().int().min(1900).max(2100),
        month: z.number().int().min(1).max(12),
        model: z.string(),
        ytd_registrations: z.number(),
        ytd_market_share: z.number(),
      })
      .strict();

    const registrations = [];
    for (const row of rows) {
      for (let i = 0; i < row.length; i += 4) {
        const model = row[i + 1];
        const ytd_registrations = row[i + 2];
        const ytd_market_share = row[i + 3];

        const parsed = YTDRegistrationsSchema.parse({
          year: dateId.year,
          month: dateId.month,
          model: decodeURIComponent(model.R[0].T).toUpperCase(),
          ytd_registrations: parseInt(
            decodeURIComponent(ytd_registrations.R[0].T).replace(/\s/g, '')
          ),
          ytd_market_share: parseFloat(
            decodeURIComponent(ytd_market_share.R[0].T)
              .replace(',', '.')
              .replace('%', '')
          ),
        });
        registrations.push(parsed);
      }
    }

    // Ordeno los registrations por ytd_registrations
    registrations.sort((a, b) => b.ytd_registrations - a.ytd_registrations);

    return [
      {
        name: 'top_100_ytd_registrations_by_model',
        data: registrations,
      },
    ];
  }

  async debug() {}
}

export default new Extractor();
