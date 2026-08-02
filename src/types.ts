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
  date: string | null;
  cam: string | null;
  gps: [number, number] | null;
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
