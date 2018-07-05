import createHTTPServer from './util/http_server';
import {Server as HTTPServer} from 'http';
import ChromeDriver from '../src/lib/chrome_driver';
import {equal as assertEqual} from 'assert';
import NopLog from '../src/common/nop_log';

const HTTP_PORT = 8890;

describe("Chrome Driver", function() {
  // 30 second timeout.
  this.timeout(30000);
  let httpServer: HTTPServer;
  let chromeDriver: ChromeDriver;
  before(async function() {
    httpServer = await createHTTPServer({
      "/": {
        mimeType: "text/html",
        data: Buffer.from("<!doctype html><html><div id='container'>ContainerText</div></html>", "utf8")
      }
    }, HTTP_PORT);
    // Silence debug messages.
    console.debug = () => {};
    chromeDriver = await ChromeDriver.Launch(NopLog, true, 1920, 1080);
  });

  it("Successfully loads a webpage", async function() {
    await chromeDriver.navigateTo(`http://localhost:${HTTP_PORT}/`);
    const str = await chromeDriver.runCode("document.getElementById('container').innerText");
    assertEqual(str, "ContainerText");
  });

  after(async function() {
    return new Promise<void>((resolve, reject) => {
      function closeChrome() {
        if (chromeDriver) {
          chromeDriver.shutdown().then(resolve, reject);
        } else {
          resolve();
        }
      }
      function closeHttpServer() {
        if (httpServer) {
          httpServer.close(closeChrome);
        } else {
          closeChrome();
        }
      }
      closeHttpServer();
    });
  });
});
