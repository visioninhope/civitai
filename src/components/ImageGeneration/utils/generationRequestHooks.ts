import { WorkflowEvent, WorkflowStepJobEvent } from '@civitai/client';
import { InfiniteData } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { useEffect, useMemo } from 'react';
import { z } from 'zod';
import { useUpdateWorkflowSteps } from '~/components/Orchestrator/hooks/workflowStepHooks';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SignalMessages } from '~/server/common/enums';
import {
  TextToImageStepImageMetadata,
  TextToImageStepMetadata,
} from '~/server/schema/orchestrator/textToImage.schema';
import { workflowQuerySchema } from '~/server/schema/orchestrator/workflows.schema';
import { workflowCompletedStatuses } from '~/server/services/orchestrator/constants';
import { UpdateWorkflowStepParams } from '~/server/services/orchestrator/orchestrator.schema';
import { getTextToImageRequests } from '~/server/services/orchestrator/textToImage';
import { createDebouncer } from '~/utils/debouncer';
import { showErrorNotification } from '~/utils/notifications';
import { queryClient, trpc } from '~/utils/trpc';

type InfiniteTextToImageRequests = InfiniteData<AsyncReturnType<typeof getTextToImageRequests>>;

export function useGetTextToImageRequests(
  input?: z.input<typeof workflowQuerySchema>,
  options?: { enabled?: boolean }
) {
  const currentUser = useCurrentUser();
  const { data, ...rest } = trpc.orchestrator.getTextToImageRequests.useInfiniteQuery(input ?? {}, {
    getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
    enabled: !!currentUser,
    ...options,
  });
  const flatData = useMemo(
    () =>
      data?.pages.flatMap((x) =>
        (x.items ?? []).map((response) => {
          const steps = response.steps.map((step) => {
            const images = step.images
              .filter((image) => !step.metadata?.images?.[image.id]?.hidden)
              .sort((a, b) => {
                if (a.completed !== b.completed) {
                  if (!b.completed) return 1;
                  if (!a.completed) return -1;
                  return b.completed.getTime() - a.completed.getTime();
                } else {
                  if (a.id < b.id) return -1;
                  if (a.id > b.id) return 1;
                  return 0;
                }
              });
            return { ...step, images };
          });
          return { ...response, steps };
        })
      ) ?? [],
    [data]
  );

  // useEffect(() => console.log({ flatData }), [flatData]);
  const steps = useMemo(() => flatData.flatMap((x) => x.steps), [flatData]);

  return { data: flatData, steps, ...rest };
}

export function useGetTextToImageRequestsImages(input?: z.input<typeof workflowQuerySchema>) {
  const { data, steps, ...rest } = useGetTextToImageRequests(input);
  return { requests: data, steps, ...rest };
}

function updateTextToImageRequests(cb: (data: InfiniteTextToImageRequests) => void) {
  const queryKey = getQueryKey(trpc.orchestrator.getTextToImageRequests);
  // const test = queryClient.getQueriesData({ queryKey, exact: false })
  queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
    produce(state, (old?: InfiniteTextToImageRequests) => {
      if (!old) return;
      cb(old);
    })
  );
}

export function useSubmitTextToImageRequest() {
  return trpc.orchestrator.createTextToImage.useMutation({
    onSuccess: (data) => {
      updateTextToImageRequests((old) => {
        old.pages[0].items.unshift(data);
      });
      updateFromEvents();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to generate',
        error: new Error(error.message),
        reason: error.message ?? 'An unexpected error occurred. Please try again later.',
      });
    },
  });
}

export function useDeleteTextToImageRequest() {
  return trpc.orchestrator.deleteWorkflow.useMutation({
    onSuccess: (_, { workflowId }) => {
      updateTextToImageRequests((data) => {
        for (const page of data.pages) {
          const index = page.items.findIndex((x) => x.id === workflowId);
          if (index > -1) page.items.splice(index, 1);
        }
      });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Error deleting request',
        error: new Error(error.message),
      });
    },
  });
}

export function useCancelTextToImageRequest() {
  return trpc.orchestrator.cancelWorkflow.useMutation({
    onSuccess: (_, { workflowId }) => {
      updateTextToImageRequests((old) => {
        for (const page of old.pages) {
          for (const item of page.items.filter((x) => x.id === workflowId)) {
            for (const step of item.steps) {
              for (const image of step.images.filter(
                (x) => !workflowCompletedStatuses.includes(x.status)
              )) {
                image.status = 'canceled';
              }
              if (step.images.some((x) => x.status === 'canceled')) {
                item.status = 'canceled';
              }
            }
          }
        }
      });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Error cancelling request',
        error: new Error(error.message),
      });
    },
  });
}

export function useUpdateTextToImageStepMetadata(options?: { onSuccess?: () => void }) {
  const queryKey = getQueryKey(trpc.orchestrator.getTextToImageRequests);
  const { updateSteps, isLoading } = useUpdateWorkflowSteps({
    queryKey,
    onSuccess: options?.onSuccess,
  });

  function updateImages(
    args: Array<{
      workflowId: string;
      stepName: string;
      imageIds: string[];
      hidden?: boolean;
      feedback?: 'liked' | 'disliked';
      comments?: string;
    }>
  ) {
    const data = args.map(
      ({
        workflowId,
        stepName,
        imageIds,
        hidden,
        feedback,
        comments,
      }): UpdateWorkflowStepParams => {
        const images: Record<string, TextToImageStepImageMetadata> = {};
        for (const imageId of imageIds) {
          images[imageId] = {};
          if (hidden) images[imageId].hidden = true;
          if (feedback) images[imageId].feedback = feedback;
          if (comments) images[imageId].comments = comments;
        }

        return { $type: 'textToImage', workflowId, stepName, metadata: { images } };
      }
    );
    updateSteps<TextToImageStepMetadata>(data, (draft, metadata) => {
      Object.keys(metadata.images ?? {}).map((imageId) => {
        const { comments, hidden, feedback } = metadata.images?.[imageId] ?? {};
        const images = draft.images ?? {};
        if (!images[imageId]) images[imageId] = {};
        if (comments) images[imageId].comments = comments;
        if (hidden) images[imageId].hidden = hidden;
        if (feedback)
          images[imageId].feedback = images[imageId].feedback !== feedback ? feedback : undefined;
        draft.images = images;
      });
    });
  }

  return { updateImages, isLoading };
}

type CustomJobEvent = Omit<WorkflowStepJobEvent, '$type'> & { $type: 'job'; completed?: Date };
type CustomWorkflowEvent = Omit<WorkflowEvent, '$type'> & { $type: 'workflow' };
const debouncer = createDebouncer(100);
const signalJobEventsDictionary: Record<string, CustomJobEvent> = {};
const signalWorkflowEventsDictionary: Record<string, CustomWorkflowEvent> = {};
export function useTextToImageSignalUpdate() {
  return useSignalConnection(
    SignalMessages.TextToImageUpdate,
    (data: CustomJobEvent | CustomWorkflowEvent) => {
      if (data.$type === 'job' && data.jobId) {
        signalJobEventsDictionary[data.jobId] = { ...data, completed: new Date() };
      } else if (data.$type === 'workflow' && data.workflowId) {
        signalWorkflowEventsDictionary[data.workflowId] = data;
      }

      debouncer(() => updateFromEvents());
    }
  );
}

function updateFromEvents() {
  if (!Object.keys(signalJobEventsDictionary).length) return;

  updateTextToImageRequests((old) => {
    for (const page of old.pages) {
      for (const item of page.items) {
        if (
          !Object.keys(signalJobEventsDictionary).length &&
          !Object.keys(signalWorkflowEventsDictionary).length
        )
          return;

        const workflowEvent = signalWorkflowEventsDictionary[item.id];
        if (workflowEvent) {
          item.status = workflowEvent.status!;
          if (item.status === signalWorkflowEventsDictionary[item.id].status)
            delete signalWorkflowEventsDictionary[item.id];
        }

        for (const step of item.steps) {
          // get all jobIds associated with images
          const imageJobIds = [...new Set(step.images.map((x) => x.jobId))];
          // get any pending events associated with imageJobIds
          const jobEventIds = Object.keys(signalJobEventsDictionary).filter((jobId) =>
            imageJobIds.includes(jobId)
          );

          for (const jobId of jobEventIds) {
            const signalEvent = signalJobEventsDictionary[jobId];
            if (!signalEvent) continue;
            const { status } = signalEvent;
            const images = step.images.filter((x) => x.jobId === jobId);
            for (const image of images) {
              image.status = signalEvent.status!;
              image.completed = signalEvent.completed;
            }

            if (status === signalJobEventsDictionary[jobId].status) {
              delete signalJobEventsDictionary[jobId];
              if (!Object.keys(signalJobEventsDictionary).length) break;
            }
          }
        }
      }
    }
  });
}
