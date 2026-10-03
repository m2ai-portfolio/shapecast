// Ambient globals supplied by the two cdnjs scripts the page loads.
declare const THREE: any;
declare const JSZip: any;

interface Window {
  claude?: { use(name: string): Promise<any> };
}
