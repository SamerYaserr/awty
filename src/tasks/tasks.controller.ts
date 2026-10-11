import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  ValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';

import { CreateTaskDto } from './dto/request/create-task.dto';
import type { TaskState } from './task.types';
import { TasksService } from './tasks.service';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    body: CreateTaskDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ id: string; status: 'pending' }> {
    const task = await this.tasks.create(body.duration);
    res.setHeader('Location', `/tasks/${task.id}`);
    return task;
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<TaskState> {
    return this.tasks.get(id);
  }
}
