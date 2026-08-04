export interface Photo {
  id: string;
  album: string;
  albumId: string;
  base: string;
  widths: number[];
  webpWidths: number[];
  thumb: string;
  fallback: string;
  w: number;
  h: number;
  lqip: string;
  color: string;
  /** Wanduhrzeit am Aufnahmeort, ohne Zonen-Suffix: "2026-07-26T17:49:49" */
  date: string | null;
  /** Nur gesetzt, wo media/clock.json eine falsch gestellte Kamera-Uhr korrigiert hat */
  dateRaw?: string;
  cam: string | null;
  gps: [number, number] | null;
  /** Aufgeloest aus media/places.json, faellt auf den Albumnamen zurueck */
  place: string | null;
  region: string | null;
  caption: string | null;
  file: string;
}

export interface Beat {
  id: string;
  title: string;
  src: string;
  dur: number | null;
  link: string | null;
}

export interface Album {
  id: string;
  name: string;
  count: number;
  from: string | null;
  to: string | null;
}

export interface Manifest {
  generated: string;
  albums: Album[];
  photos: Photo[];
  beats: Beat[];
}
