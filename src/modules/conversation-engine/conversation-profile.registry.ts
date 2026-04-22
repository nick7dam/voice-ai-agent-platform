import { Injectable } from '@nestjs/common';
import { ConversationProfileKey } from '../../common/types/conversation.types';

export interface ConversationSlotDefinition {
  key: string;
  label: string;
  required: boolean;
  confirmationRequired?: boolean;
  askPrompt: string;
}

export interface ConversationProfile {
  key: ConversationProfileKey;
  intentName: string;
  description: string;
  defaultHoldMs: number;
  incompleteHoldMs: number;
  slotOrder: string[];
  actionReadySlotKeys: string[];
  slotDefinitions: Record<string, ConversationSlotDefinition>;
}

const genericProfile: ConversationProfile = {
  key: 'generic',
  intentName: 'general_assistance',
  description:
    'General spoken assistant flow without task-specific slot logic.',
  defaultHoldMs: 120,
  incompleteHoldMs: 250,
  slotOrder: [],
  actionReadySlotKeys: [],
  slotDefinitions: {},
};

const carBookingReceptionistProfile: ConversationProfile = {
  key: 'car_booking_receptionist',
  intentName: 'service_booking',
  description:
    'Collect the minimum details needed for a vehicle service booking while staying concise and spoken.',
  defaultHoldMs: 180,
  incompleteHoldMs: 300,
  slotOrder: [
    'serviceType',
    'vehicleRegistration',
    'customerName',
    'phoneNumber',
    'customerEmail',
    'preferredDate',
    'preferredTime',
    'issueDescription',
  ],
  actionReadySlotKeys: [
    'serviceType',
    'vehicleRegistration',
    'customerName',
    'phoneNumber',
    'preferredDate',
  ],
  slotDefinitions: {
    serviceType: {
      key: 'serviceType',
      label: 'service type',
      required: true,
      askPrompt: 'What type of service do you need for the vehicle?',
    },
    vehicleRegistration: {
      key: 'vehicleRegistration',
      label: 'vehicle registration',
      required: true,
      confirmationRequired: true,
      askPrompt:
        'What is the vehicle registration? You can say it one character at a time, like A B C 1 2 3.',
    },
    customerName: {
      key: 'customerName',
      label: 'customer name',
      required: true,
      askPrompt:
        'Can I get your name for the booking? You can spell it if that is easier.',
    },
    phoneNumber: {
      key: 'phoneNumber',
      label: 'phone number',
      required: true,
      confirmationRequired: true,
      askPrompt:
        'What is the best phone number for the booking? You can say the digits one at a time.',
    },
    customerEmail: {
      key: 'customerEmail',
      label: 'email address',
      required: false,
      askPrompt:
        'Would you like to add an email address for the booking? You can say it like name at gmail dot com.',
    },
    preferredDate: {
      key: 'preferredDate',
      label: 'preferred date',
      required: true,
      askPrompt: 'What day would you like to book it for?',
    },
    preferredTime: {
      key: 'preferredTime',
      label: 'preferred time',
      required: false,
      askPrompt: 'Is there a preferred time of day?',
    },
    issueDescription: {
      key: 'issueDescription',
      label: 'issue description',
      required: false,
      askPrompt: 'Is there anything specific you want us to check?',
    },
  },
};

@Injectable()
export class ConversationProfileRegistryService {
  private readonly profiles = new Map<
    ConversationProfileKey,
    ConversationProfile
  >([
    ['generic', genericProfile],
    ['car_booking_receptionist', carBookingReceptionistProfile],
  ]);

  getProfileForTask(taskKey: string): ConversationProfile {
    if (taskKey === 'car_booking_receptionist') {
      return carBookingReceptionistProfile;
    }

    return genericProfile;
  }

  get(profileKey: ConversationProfileKey): ConversationProfile {
    return this.profiles.get(profileKey) ?? genericProfile;
  }
}
