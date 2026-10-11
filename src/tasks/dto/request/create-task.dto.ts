import { IsInt, Max, Min } from 'class-validator';

import { MAX_DURATION_SECONDS, MIN_DURATION_SECONDS } from '../../task.types';

export class CreateTaskDto {
  @IsInt({ message: 'duration must be a whole number of seconds' })
  @Min(MIN_DURATION_SECONDS, {
    message: `duration must be at least ${MIN_DURATION_SECONDS} second`,
  })
  @Max(MAX_DURATION_SECONDS, {
    message: `duration must be at most ${MAX_DURATION_SECONDS} seconds`,
  })
  duration!: number;
}
