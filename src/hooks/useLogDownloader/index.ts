import { useEffect, useState } from "react";
import { useLogDownloadAnalytics } from "analytics";
import { LogTypes } from "constants/enums";
import {
  LOG_FILE_DOWNLOAD_TOO_LARGE_WARNING,
  LOG_LINE_TOO_LARGE_WARNING,
} from "constants/errors";
import { LOG_FILE_SIZE_LIMIT } from "constants/logs";
import { useToastContext } from "context/toast";
import useStateRef from "hooks/useStateRef";
import { isProduction } from "utils/environmentVariables";
import {
  SentryBreadcrumb,
  leaveBreadcrumb,
  reportError,
} from "utils/errorReporting";
import { fetchLogFile } from "utils/fetchLogFile";
import { getBytesAsString } from "utils/string";

type UseLogDownloader = {
  downloadSizeLimit?: number;
  logType: LogTypes;
  url: string;
};

/**
 * `useLogDownloader` is a custom hook that downloads a log file from a given URL.
 * It uses a fetch stream to download the log file and splits the log file into an array of strings.
 * Each string is split based on the newline character.
 * @param props - hook params object
 * @param props.url - the url to fetch
 * @param props.logType - the type of log file to download
 * @param props.downloadSizeLimit - the maximum size of the log file to download
 * @returns an object with the following properties:
 * - isLoading: a boolean that is true while the log is being downloaded
 * - data: the log file as an array of strings
 * - error: an error message if the download fails
 * - fileSize: the size of the log file in bytes
 */
const useLogDownloader = ({
  downloadSizeLimit = LOG_FILE_SIZE_LIMIT,
  logType,
  url,
}: UseLogDownloader) => {
  const [data, setData] = useState<string[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [fileSize, setFileSize, getFileSize] = useStateRef<number>(0);
  const [isLoading, setIsLoading] = useState(false);
  const { sendEvent } = useLogDownloadAnalytics();
  const dispatchToast = useToastContext();

  useEffect(() => {
    leaveBreadcrumb("useLogDownloader", { url }, SentryBreadcrumb.HTTP);
    const abortController = new AbortController();
    const timeStart = Date.now();

    if (url) {
      setIsLoading(true);
      fetchLogFile(url, {
        // Conditionally define signal because AbortController throws error in development's strict mode
        abortController: isProduction() ? abortController : undefined,
        downloadSizeLimit,
        onIncompleteDownload: (reason, incompleteDownloadError) => {
          reportError(new Error("Incomplete download"), {
            message: reason,
            metadata: {
              incompleteDownloadError,
              url,
            },
            name: "Log download incomplete",
          }).warning();

          dispatchToast.warning(LOG_FILE_DOWNLOAD_TOO_LARGE_WARNING, true, {
            shouldTimeout: false,
            title: "Log not fully downloaded",
          });
          sendEvent({
            downloaded: getFileSize(),
            duration: Date.now() - timeStart,
            name: "Log Download Incomplete",
            reason,
          });
        },
        onProgress: (progress) => {
          setFileSize(getFileSize() + progress);
        },
      })
        .then(({ result: logs, trimmedLines }) => {
          // Remove the last log line if it is empty
          if (logs[logs.length - 1] === "") {
            logs.pop();
          }
          setData(logs);
          if (trimmedLines) {
            sendEvent({
              downloaded: getFileSize(),
              duration: Date.now() - timeStart,
              name: "Log Download Incomplete",
              reason: "Log line size limit exceeded",
            });
            reportError(new Error("Incomplete download"), {
              message: "Log line size limit exceeded",
              metadata: {
                trimmedLines,
                url,
              },
              name: "Log download incomplete",
            }).warning();
            dispatchToast.warning(LOG_LINE_TOO_LARGE_WARNING, true, {
              shouldTimeout: false,
              title: "Log not fully downloaded",
            });
          }
        })
        .catch((err: Error) => {
          leaveBreadcrumb(
            "useLogDownloader",
            {
              duration: Date.now() - timeStart,
              err,
              fileSize: getFileSize(),
              url,
            },
            SentryBreadcrumb.Error,
          );
          reportError(err).warning();
          setError(err.message);
          sendEvent({
            duration: Date.now() - timeStart,
            fileSize: getFileSize(),
            name: "Log Download Failed",
            type: logType,
          });
        })
        .finally(() => {
          leaveBreadcrumb(
            "useLogDownloader",
            {
              fileSize: getBytesAsString(getFileSize()),
              time: Date.now() - timeStart,
              url,
            },
            SentryBreadcrumb.HTTP,
          );
          sendEvent({
            duration: Date.now() - timeStart,
            fileSize: getFileSize(),
            name: "Log Downloaded",
            type: logType,
          });
          setIsLoading(false);
        });
    }

    return () => {
      // Cancel the request if the component unmounts
      abortController.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return { data, error, fileSize, isLoading };
};

export { useLogDownloader };
